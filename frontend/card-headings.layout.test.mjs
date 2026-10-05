import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { TranscriptContent } from "./shared/transcript-react.js";

const css = (await Promise.all(
  ["conversation.css", "review-cards.css", "delegate-cards.css", "goal-cards.css", "fork-cards.css", "styles.css"]
    .map((name) => readFile(new URL(`./${name}`, import.meta.url), "utf8"))
)).join("\n");
const titles = {
  sentence: "Review the remote delegate card title and compare it with every other local and remote card. ".repeat(4),
  cjk: "检查远程委派卡片的超长标题并且对比本地其他卡片是否也会出现同样的问题。".repeat(5),
  unbroken: "remote_delegate_card_with_a_very_long_session_title_".repeat(4),
};
const row = (id, kind, injection, text = "A short brief.") => ({
  item_id: id, kind, status: "completed", text, injection,
});
const delegateCall = (ask) => ({
  ...row("request", "tool_call", { kind: "delegate_call", delegate: [ask] }),
  tool: { item_type: "mcpToolCall", name: "delegate", title: "delegate" },
});
const sentAt = Math.floor(Date.now() / 1000) - 60;

function fixtures(title) {
  const ask = {
    id: "ask", asker_thread_id: "asker", asker_provider: "claude_code", asker_title: title,
    peer_thread_id: "peer", peer_provider: "codex", title, task: "A short brief.",
    status: "working", asked_at: sentAt - 10, sent_at: sentAt,
  };
  const answered = { ...ask, status: "done", finished_at: sentAt + 20, answer: "Done.", delivered: true };
  const handover = {
    id: "handover", source_thread_id: "source", source_provider: "claude_code", source_title: title,
    target_thread_id: "target", target_provider: "codex", target_title: title, status: "done", created_at: 1,
  };
  const review = {
    id: "review", round: 1, max_rounds: 3, parent_thread_id: "parent", parent_title: title,
    parent_provider: "claude_code", reviewer_thread_id: "reviewer", reviewer_provider: "codex",
    status: "running", rounds: [{ round: 1, started_at: 1, findings: [], fixed: [] }],
  };
  return {
    delegated: [delegateCall(ask)],
    task: [row("task", "user_text", { kind: "delegate_task", delegate: [ask] })],
    answered: [row("answer", "user_text", { kind: "delegate_answer", delegate: [answered] })],
    missing: [row("missing", "user_text", { kind: "delegate_answer", delegate: [{ ...ask, status: "failed" }] })],
    reported: [
      row("task", "user_text", { kind: "delegate_task", delegate: [answered] }),
      row("report", "agent_text", null, "Done."),
    ],
    collapsed: [
      delegateCall(answered),
      row("answer", "user_text", { kind: "delegate_answer", delegate: [answered] }),
    ],
    handover: [
      row("request", "user_text", { kind: "handover_request", handover }),
      row("summary", "agent_text", { kind: "handover_summary", handover }),
    ],
    pickup: [row("pickup", "user_text", { kind: "handover_brief", handover })],
    review: [row("review", "user_text", { kind: "review_brief", review })],
    "review-result": [row("review-result", "user_text", {
      kind: "review_result",
      review: {
        ...review,
        status: "addressing_findings",
        rounds: [{
          round: 1, reviewer_thread_id: "reviewer", verdict: "needs_changes",
          started_at: sentAt - 10, finished_at: sentAt + 20,
          findings: [{ severity: "medium", text: title }], findings_total: 1,
          fixed: [], fixed_total: 0,
        }],
      },
    })],
    fork: [row("fork", "user_text", {
      kind: "fork_brief", fork: { id: "fork", source_thread_id: "source", source_provider: "claude_code", source_title: title, created_at: 1 },
    })],
    goal: [row("goal", "tool_call", {
      kind: "goal_settled", goal_settled: { goal_id: "goal", thread_id: "thread", objective: title, status: "complete_claimed", turns: 10, report: "Done." },
    })],
  };
}

const cases = Object.entries(titles).flatMap(([titleKind, title]) =>
  Object.entries(fixtures(title)).map(([cardKind, entries]) => {
    const markup = renderToStaticMarkup(React.createElement(TranscriptContent, {
      entries, options: { provider: "claude_code" },
    }));
    return `<section data-case="${titleKind}-${cardKind}">${markup}</section>`;
  })
).join("");

function measureHeadings() {
  const problems = [];
  const column = document.querySelector(".chat-thread").getBoundingClientRect();
  for (const section of document.querySelectorAll("[data-case]")) {
    const label = section.dataset.case;
    const cards = section.querySelectorAll(".handover-card, .delegate-strip");
    const expected = label.endsWith("-reported") || label.endsWith("-collapsed") ? 2 : 1;
    if (cards.length !== expected) problems.push(`${label}: expected ${expected} cards, got ${cards.length}`);
    if (label.endsWith("-collapsed") && !section.querySelector(".delegate-strip")) {
      problems.push(`${label}: the delegate card did not collapse`);
    }
    if (label.endsWith("-review-result") && !section.querySelector(".review-finding")) {
      problems.push(`${label}: the review round's findings did not render`);
    }
    for (const card of cards) {
      const edge = card.getBoundingClientRect();
      if (edge.left < column.left - 1 || edge.right > column.right + 1) {
        problems.push(`${label}: card extends past the transcript`);
      }
      for (const text of card.querySelectorAll(".handover-card-title, .handover-card-kicker, .review-strip-text")) {
        const style = getComputedStyle(text);
        if (style.whiteSpace !== "nowrap" && text.scrollWidth > text.clientWidth + 1) {
          problems.push(`${label}: ${text.className} overflows (${text.scrollWidth}px > ${text.clientWidth}px)`);
        }
        if (style.whiteSpace === "nowrap" && text.scrollWidth > text.clientWidth && style.textOverflow !== "ellipsis") {
          problems.push(`${label}: long text is clipped without an ellipsis`);
        }
      }
    }
  }
  return problems;
}

for (const surface of ["local", "remote"]) {
  for (const width of [1280, 390]) {
    test(`${surface} at ${width}px: card headings fit beside their timestamps`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}
          *, *::before, *::after { animation: none !important; transition: none !important; }
          </style></head><body>
          <main class="chat-shell ${surface === "remote" ? "remote-chat-shell" : ""}" data-view="conversation">
          <div class="chat-thread" id="${surface === "remote" ? "remote-transcript" : "transcript"}">${cases}</div>
          </main></body></html>`, { waitUntil: "load" });
        const problems = await page.evaluate(measureHeadings);
        if (process.env.CARD_TITLE_SHOTS) {
          await mkdir(process.env.CARD_TITLE_SHOTS, { recursive: true });
          const prefix = path.join(process.env.CARD_TITLE_SHOTS, `${surface}-${width}`);
          await page.locator('[data-case="unbroken-task"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${prefix}.png` });
          await writeFile(`${prefix}.json`, JSON.stringify(problems, null, 2));
        }
        assert.deepEqual(problems, []);
      } finally {
        await browser.close();
      }
    });
  }
}
