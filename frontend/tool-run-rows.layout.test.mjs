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
      const running = document.querySelector(".tool-run-row .tool-run-title").getBoundingClientRect().left;
      const done = document.querySelector(".work-group-lead").getBoundingClientRect().left;
      const dot = document.querySelector(".tool-run-live");
      const probe = document.createElement("span");
      probe.style.color = "var(--ok-fg)";
      document.body.append(probe);
      const green = getComputedStyle(probe).color;
      const dotStyle = getComputedStyle(dot);
      return {
        titles: [running, done],
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
// A finished lone tool folds into a group (20c-3); a running one is still a row of its own.
const SPACING_ENTRIES = [
  agent("a1", "Checking first."),
  bash("c1", "running"),
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

const fileChange = (id, path) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  tool: {
    item_type: "fileChange",
    name: "Edit",
    file_changes: [
      {
        path,
        change_type: "modify",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  },
});

// Opened file-change groups used to keep per-row accent cards (taller than tool
// rows, with gaps that broke the hairline). They must measure like tool groups.
test("an opened file-change group matches tool-group density on the hairline", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(
      page,
      [
        cursorTool("t1", "grep"),
        cursorTool("t2", "Find"),
        fileChange("fc1", "frontend/a.js"),
        fileChange("fc2", "frontend/b.js"),
      ],
      { expandedKeys: new Set(["group:t1", "group:fc1"]) }
    );
    const m = await page.evaluate(() => {
      const toolMembers = [...document.querySelectorAll(".chat-message-tool:not(.chat-message-file-change).is-group-member")];
      const fileMembers = [...document.querySelectorAll(".chat-message-file-change.is-group-member")];
      const toolRow = document.querySelector(".tool-run-row")?.getBoundingClientRect().height ?? 0;
      const fileHeaders = fileMembers.map((node) =>
        node.querySelector(".diff-file-section-header")?.getBoundingClientRect().height ?? 0
      );
      const fileCards = fileMembers.map((node) => {
        const card = node.querySelector(".message-card-tool");
        return card ? parseFloat(getComputedStyle(card).borderLeftWidth) : -1;
      });
      const chip = document.querySelector(".chat-message-diff-group .work-group-chip")
        || document.querySelector(".chat-message-diff-group .diff-group-chip");
      const firstFile = fileMembers[0];
      return {
        toolSeams: toolMembers.slice(1).map((node, i) =>
          Math.round(node.getBoundingClientRect().top - toolMembers[i].getBoundingClientRect().bottom)
        ),
        fileSeams: fileMembers.slice(1).map((node, i) =>
          Math.round(node.getBoundingClientRect().top - fileMembers[i].getBoundingClientRect().bottom)
        ),
        chipToFirst: chip && firstFile
          ? Math.round(firstFile.getBoundingClientRect().top - chip.getBoundingClientRect().bottom)
          : null,
        toolRow: Math.round(toolRow * 10) / 10,
        fileHeaders: fileHeaders.map((h) => Math.round(h * 10) / 10),
        fileCardBorders: fileCards,
        usesWorkGroupChip: Boolean(document.querySelector(".chat-message-diff-group .work-group-chip")),
      };
    });
    assert.equal(m.usesWorkGroupChip, true, "diff group must use the work-group chip");
    assert.deepEqual(m.toolSeams, [0], "tool members stay flush");
    assert.deepEqual(m.fileSeams, [0], "file-change members stay flush like tools");
    assert.equal(m.chipToFirst, 0, "first file row sits flush under the chip");
    assert.deepEqual(m.fileCardBorders, [0, 0], "no per-file accent stripe");
    for (const height of m.fileHeaders) {
      assert.ok(
        height <= m.toolRow + 4,
        `file header ${height}px should stay near tool row ${m.toolRow}px`
      );
    }
  } finally {
    await browser.close();
  }
});

const SHELL = `/bin/zsh -lc "command -v superset; test -f /Users/luchi/.codex/plugins/cache/browser-client.mjs"`;
const manyLines = (n) => Array.from({ length: n }, (_, i) => `line ${i} -rwxr-xr-x 1 luchi staff 122 /Users/luchi/bin/tool`).join("\n");
const codexCommand = (id, status, output) => ({
  item_id: id,
  kind: "command",
  status,
  text: `${SHELL}\n${output}`,
  tool: { command: SHELL },
});
const claudeBash = (id, status, { command = "npm run build", result = "ok" } = {}) => ({
  item_id: id,
  kind: "tool_call",
  status,
  tool: {
    item_type: "toolCall",
    name: "Bash",
    title: "Run the build script",
    detail: "Build it",
    command,
    result_preview: result,
  },
});
const opened = (...ids) => new Set(ids.flatMap((id) => [`group:${id}`, `entry:${id}`, `tool:${id}:result`]));

// Opened, a Codex command read at 13px and Claude's Bash at 12px, under an 11px row.
test("an opened tool's text is no larger than the row it opened from, running or done", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(
      page,
      [
        codexCommand("c1", "completed", "done"),
        agent("a1", "next"),
        codexCommand("c2", "running", "still going"),
        agent("a2", "next"),
        claudeBash("b1", "completed"),
        agent("a3", "next"),
        claudeBash("b2", "running"),
      ],
      { expandedKeys: opened("c1", "c2", "b1", "b2") }
    );
    const m = await page.evaluate(() => {
      const size = (node) => getComputedStyle(node).fontSize;
      const all = (selector) => [...document.querySelectorAll(selector)];
      return {
        rowCommand: size(document.querySelector(".tool-run-command")),
        rowTitle: size(document.querySelector('[data-transcript-entry-id="b1"] .tool-run-title')),
        bodies: all(".command-detail, .tool-run-full-command, .tool-log-pre").map((node) => [node.className, size(node)]),
        subtitles: all(".tool-run-subtitle").map(size),
      };
    });
    assert.ok(m.bodies.length >= 6, `expected every opened body, got ${m.bodies.length}`);
    for (const [name, value] of m.bodies) {
      assert.equal(value, m.rowCommand, `${name} reads at ${value}, the row's command at ${m.rowCommand}`);
    }
    assert.equal(m.subtitles.length, 2);
    for (const value of m.subtitles) {
      assert.ok(parseFloat(value) <= parseFloat(m.rowTitle), `subtitle ${value} above row title ${m.rowTitle}`);
    }
  } finally {
    await browser.close();
  }
});

test("a long opened tool body scrolls inside a bounded box; a short one is left alone", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(
      page,
      [
        codexCommand("c1", "completed", manyLines(200)),
        agent("a1", "next"),
        codexCommand("c2", "running", manyLines(200)),
        agent("a2", "next"),
        claudeBash("b1", "completed", { command: `cat <<'EOF'\n${manyLines(200)}\nEOF`, result: manyLines(200) }),
        agent("a3", "next"),
        codexCommand("c3", "completed", "one line"),
      ],
      { expandedKeys: opened("c1", "c2", "b1", "c3") }
    );
    const m = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        return {
          height: Math.round(node.getBoundingClientRect().height),
          overflows: node.scrollHeight - node.clientHeight,
          overflowY: getComputedStyle(node).overflowY,
        };
      };
      return {
        long: {
          done: box('[data-transcript-entry-id="c1"] .command-detail'),
          running: box('[data-transcript-entry-id="c2"] .command-detail'),
          command: box('[data-transcript-entry-id="b1"] .tool-run-full-command'),
          result: box('[data-transcript-entry-id="b1"] .message-collapsible-full .tool-log-pre'),
        },
        short: box('[data-transcript-entry-id="c3"] .command-detail'),
      };
    });
    for (const [name, b] of Object.entries(m.long)) {
      assert.ok(b.height >= 150 && b.height <= 400, `${name} box is ${b.height}px tall`);
      assert.ok(b.overflows > 1000, `${name} keeps the rest of its lines to scroll to (${b.overflows}px)`);
      assert.ok(["auto", "scroll"].includes(b.overflowY), `${name} scrolls inside (${b.overflowY})`);
    }
    assert.ok(m.short.overflows <= 0, "a short body needs no scrolling");
    assert.ok(m.short.height < 80, `a short body stays short (${m.short.height}px)`);
  } finally {
    await browser.close();
  }
});

// A phone screen holds far less, so the box stops at about 12 lines there, 20 elsewhere.
test("an opened tool body shows about 20 lines on a wide screen and about 12 on a phone", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const visibleLines = async (viewport) => {
      const page = await browser.newPage({ viewport });
      const markup = renderToStaticMarkup(
        h(TranscriptContent, {
          entries: [
            codexCommand("c1", "completed", manyLines(200)),
            agent("a1", "next"),
            claudeBash("b1", "completed", { result: manyLines(200) }),
          ],
          options: { expandedKeys: opened("c1", "b1") },
        })
      );
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>
          <div class="chat-thread">${markup}</div></body></html>`,
        { waitUntil: "load" }
      );
      const lines = await page.evaluate(() =>
        ['[data-transcript-entry-id="c1"] .command-detail', '[data-transcript-entry-id="b1"] .message-collapsible-full .tool-log-pre']
          .map((selector) => {
            const node = document.querySelector(selector);
            const style = getComputedStyle(node);
            const inner = node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            return Math.round(inner / parseFloat(style.lineHeight));
          })
      );
      await page.close();
      return lines;
    };
    for (const lines of await visibleLines({ width: 1200, height: 900 })) {
      assert.ok(lines >= 18 && lines <= 21, `wide screen shows ${lines} lines`);
    }
    for (const lines of await visibleLines({ width: 390, height: 844 })) {
      assert.ok(lines >= 11 && lines <= 13, `phone shows ${lines} lines`);
    }
  } finally {
    await browser.close();
  }
});
