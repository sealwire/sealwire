// Measured in a browser: where a card's text starts is only known after layout.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { ReviewerPanel } from "./shared/reviewer-panel.js";
import { TranscriptContent } from "./shared/transcript-react.js";

const h = React.createElement;
// Same order as the app's @imports, which a <style> block cannot follow.
const css = ["conversation.css", "review-cards.css", "delegate-cards.css", "goal-cards.css", "styles.css"]
  .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))
  .join("\n");

const LONG = "这句话写得很长，长到在卡片里一定会换行，折叠以后只该露出开头的两行。";
const AT = 1_790_000_000;
const round = {
  round: 1,
  reviewer_thread_id: "rev",
  verdict: "needs_changes",
  findings: [
    { severity: "high", text: LONG, location: "crates/relay-server/src/state/relay/background.rs:1234" },
    { severity: "medium", text: LONG, location: null },
    { severity: "low", text: LONG, location: null },
  ],
  findings_total: 3,
  fixed: [],
  fixed_total: 0,
  base_sha: "3a0e1f2aa4b5c6d7",
  candidate_sha: "7be04d1bb4b5c6d7",
  started_at: AT,
  finished_at: AT + 120,
  delivered: true,
};
const reviewJob = {
  id: "review-1",
  round: 1,
  max_rounds: 1,
  parent_thread_id: "me",
  reviewer_thread_id: "rev",
  reviewer_provider: "codex",
  status: "complete",
  result: { kind: "review_result", round: 1, rounds: [round] },
  updated_at: AT + 120,
};
const panel = renderToStaticMarkup(
  h(ReviewerPanel, {
    parentThreadId: "me",
    onOpenThread: () => {},
    handovers: [
      {
        id: "out",
        source_thread_id: "me",
        target_thread_id: "next",
        target_provider: "codex",
        target_title: "Pi provider",
        status: "done",
        created_at: AT,
        next: LONG,
      },
      {
        id: "in",
        source_thread_id: "before",
        source_title: "Fix goal gate",
        source_provider: "claude_code",
        target_thread_id: "me",
        status: "done",
        created_at: AT - 60,
        goal: LONG,
        state: "改了一半",
        next: LONG,
      },
    ],
    reviewJobs: [reviewJob],
    asks: [
      {
        id: "ask-1",
        asker_thread_id: "me",
        asker_provider: "claude_code",
        peer_thread_id: "peer",
        peer_provider: "codex",
        task: "问下 Codex",
        title: "继续审查同一个 worktree",
        status: "done",
        delivered: true,
        answered_with_tool: true,
        answer: LONG,
        asked_at: AT,
        sent_at: AT + 10,
        finished_at: AT + 100,
        updated_at: AT + 100,
      },
    ],
    canRequest: false,
  })
);
const transcriptReview = renderToStaticMarkup(
  h(TranscriptContent, {
    entries: [
      {
        item_id: "r1",
        kind: "user_text",
        status: "completed",
        text: "P",
        injection: { kind: "review_result", review: { ...reviewJob, rounds: [round] } },
      },
    ],
    options: { provider: "claude_code" },
  })
);

async function measure(width) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1600 } });
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body style="margin:0">
        <div id="panel" style="width:${width}px">${panel}</div>
        <div class="chat-thread" id="chat" style="width:${width}px">${transcriptReview}</div></body></html>`,
      { waitUntil: "load" }
    );
    return await page.evaluate(() => {
      const textLeft = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.data.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = [...range.getClientRects()].find((r) => r.width > 1);
          if (rect) return Math.round(rect.left * 2) / 2;
        }
        return null;
      };
      const lefts = (root, selector) =>
        [...document.querySelectorAll(`${root} ${selector}`)].map((el) => [el.textContent.trim().slice(0, 10), textLeft(el)]);
      return {
        cardText: textLeft(document.querySelector("#panel .reviewer-ask .reviewer-card-title")),
        handoverText: lefts("#panel", ".reviewer-handover-body :is(h3, dt, dd)"),
        panelFindings: lefts("#panel", ".review-finding-text"),
        chatFindings: lefts("#chat", ".review-finding-text"),
      };
    });
  } finally {
    await browser.close();
  }
}

for (const width of [340, 390]) {
  test(`${width}px: a handover's lines start where the delegated card's text starts`, async () => {
    const { cardText, handoverText } = await measure(width);
    assert.ok(cardText > 0, "the delegated card rendered no title to line up with");
    assert.ok(handoverText.length >= 6, `expected both handovers' lines, got ${JSON.stringify(handoverText)}`);
    assert.deepEqual(
      handoverText.filter(([, left]) => left !== cardText),
      [],
      `every handover line should start at ${cardText}px`
    );
  });

  test(`${width}px: every finding's text starts at one edge, whatever its severity tag`, async () => {
    const { panelFindings, chatFindings } = await measure(width);
    for (const [where, findings] of [["panel", panelFindings], ["conversation", chatFindings]]) {
      assert.equal(findings.length, 3, `${where} should list all three findings`);
      assert.deepEqual(
        findings.map(([, left]) => left),
        findings.map(() => findings[0][1]),
        `${where} findings start at different edges: ${JSON.stringify(findings)}`
      );
    }
  });
}
