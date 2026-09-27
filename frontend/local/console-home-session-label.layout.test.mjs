// An unnamed session is labelled by its whole first prompt, which can be pages long,
// so a session-name line must be capped by laid-out height rather than trust its length.
// Other detail lines (paths, ids) end in the part you need and must stay whole.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { ReadyConversationState } from "../shared/conversation.js";
import { LocalTranscriptPanel } from "./local-transcript-panel.js";

const h = React.createElement;
// styles.css reaches conversation.css through an @import that setContent cannot resolve.
const styles = ["../styles.css", "../conversation.css"]
  .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"))
  .join("\n");
const LONG_LABEL = `## Goal ${"继续分析 SealWire Cloud 的持续资源消耗攻击面，重点回答配对链接的成本。".repeat(30)}`;

const consoleHome = (label) =>
  h(LocalTranscriptPanel, {
    activeThreadId: "thread-live-1",
    activeThreadLabel: label,
    entries: [],
    viewingConversation: false,
  });
const loadingSession = (label) =>
  h(LocalTranscriptPanel, {
    entries: [],
    requestedSessionLabel: label,
    viewingConversation: false,
    viewingDifferentThread: true,
  });

async function withPage(width, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    return await run(async (element) => {
      await page.setContent(
        `<!doctype html><html><head><style>${styles}</style></head><body>${renderToStaticMarkup(element)}</body></html>`,
        { waitUntil: "load" }
      );
      return page.evaluate(() => {
        const node = document.querySelector(".thread-empty-detail");
        return {
          height: node.getBoundingClientRect().height,
          hidden: node.scrollHeight > node.clientHeight,
          title: node.getAttribute("title"),
        };
      });
    });
  } finally {
    await browser.close();
  }
}

for (const [name, screen, prefix] of [
  ["console home", consoleHome, "Current session"],
  ["loading a session", loadingSession, "Requested session"],
]) {
  test(`${name} caps a long session name at two lines and keeps the full text`, async () => {
    await withPage(1280, async (measure) => {
      const oneLine = await measure(screen("Short"));
      const long = await measure(screen(LONG_LABEL));

      assert.ok(oneLine.height > 0, "the detail line must be laid out");
      assert.ok(
        long.height <= oneLine.height * 2 + 1,
        `long label must stop at two lines: ${long.height}px vs one line ${oneLine.height}px`
      );
      assert.equal(long.title, `${prefix}: ${LONG_LABEL}`);
    });
  });
}

test("a workspace path line is never cut, even on a phone", async () => {
  await withPage(390, async (measure) => {
    const ready = await measure(
      h(ReadyConversationState, {
        canWrite: true,
        session: {
          active_thread_id: "thread-abcdef123456",
          current_cwd: "/Users/someone/git/a-rather-long-repository-name/.claude/worktrees/a-long-worktree-name",
        },
      })
    );
    assert.equal(ready.hidden, false, "the path's tail and the session id must stay visible");
  });
});
