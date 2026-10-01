// Measured in a browser: whether a turn line stays one line, whether a long step title or
// objective is cut rather than pushing the card, and whether a step's turn label keeps
// clear of its title — only layout can say.
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
const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; }
  .chat-message { content-visibility: visible !important; }`;

const LONG = "这句话写得很长，长到在卡片里一定会换行，折叠以后只该露出开头的两行，后面的都要藏好。";
const OBJECTIVE = `${LONG}${LONG}${LONG}`;
const STEPS = [
  { title: "设计 Usage 下方按 session 查看用量", status: "done", note: LONG, turn: 1 },
  { title: `${LONG}${LONG}`, status: "active", note: "codex has it", turn: 12 },
  { title: "独立验证", status: "pending" },
];
const settled = (id, card) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  text: "",
  tool: { item_type: "mcpToolCall", name: "goal_complete", title: "goal_complete", input_preview: "{}" },
  injection: {
    kind: "goal_settled",
    goal_settled: {
      goal_id: "g",
      thread_id: "t",
      objective: OBJECTIVE,
      turns: 12,
      max_turns: 20,
      provider: "claude_code",
      steps: STEPS,
      left_for_you: [LONG],
      report: "Done.",
      options: [],
      resolution: null,
      ...card,
    },
  },
});
const transcript = renderToStaticMarkup(
  h(TranscriptContent, {
    entries: [
      {
        item_id: "turn",
        kind: "user_text",
        status: "completed",
        text: "continue",
        injection: {
          kind: "goal_turn",
          goal_turn: { goal_id: "g", turn: 12, max_turns: 20, step: { index: 2, total: 3, title: `${LONG}${LONG}` } },
        },
      },
      settled("claim", { status: "complete_claimed" }),
      settled("ask", { status: "awaiting_user", report: LONG, options: [`${LONG}`, "Use opus 5.5 high"] }),
    ],
    options: { provider: "claude_code" },
  })
);
const panel = renderToStaticMarkup(
  h(ReviewerPanel, {
    goal: { id: "g", thread_id: "t", objective: OBJECTIVE, status: "awaiting_user", turns: 12, max_turns: 20, outcome: LONG, steps: STEPS, options: [LONG] },
    reviewJobs: [],
    canRequest: false,
    onStopGoal() {},
    onResumeGoal() {},
    onReplyGoal() {},
    onSendGoalOption() {},
  })
);

function measure() {
  const problems = [];
  const box = (el) => el.getBoundingClientRect();
  const lineHeight = (el) => parseFloat(getComputedStyle(el).lineHeight);

  const line = document.querySelector(".goal-turn");
  const step = line.querySelector(".goal-turn-step");
  const count = line.querySelector(".goal-turn-count");
  const rule = line.querySelector(".goal-turn-rule");
  if (box(line).height >= 2 * lineHeight(line)) problems.push(`turn line wraps (${box(line).height}px)`);
  if (Math.abs(box(count).top - box(step).top) > 2) problems.push("the step is not on the turn's line");
  if (!(step.scrollWidth > step.clientWidth)) problems.push("a long step title is not cut short on the turn line");
  if (count.scrollWidth > count.clientWidth) problems.push("the turn count is cut");
  if (box(rule).width < 20) problems.push(`the rule collapsed to ${box(rule).width}px`);

  const column = box(document.querySelector("[data-surface='thread']"));
  for (const card of document.querySelectorAll(".goal-card")) {
    const edge = box(card);
    if (edge.right > column.right + 1) problems.push("a goal card runs past its column");
    const title = card.querySelector(".handover-card-title");
    if (!(title.scrollWidth > title.clientWidth)) problems.push("a long objective is not cut to one line");
    for (const button of card.querySelectorAll("button")) {
      if (box(button).right > edge.right + 1) problems.push(`"${button.textContent.slice(0, 12)}" runs past its card`);
    }
  }

  for (const row of document.querySelectorAll(".goal-step")) {
    const title = box(row.querySelector(".goal-step-title"));
    const turn = row.querySelector(".goal-step-turn");
    const mark = box(row.querySelector(".goal-step-mark"));
    const where = row.querySelector(".goal-step-title").textContent.slice(0, 10);
    if (turn.textContent && box(turn).left < title.right - 1) problems.push(`"${where}": turn label overlaps the title`);
    const firstLine = title.top + lineHeight(row.querySelector(".goal-step-title")) / 2;
    if (Math.abs(mark.top + mark.height / 2 - firstLine) > 3) problems.push(`"${where}": mark is off its first line`);
  }

  const goalTitle = document.querySelector(".reviewer-goal-title");
  const lines = Math.round(box(goalTitle).height / lineHeight(goalTitle));
  if (lines !== 2) problems.push(`the Agents card's objective shows ${lines} lines, not 2`);
  if (!(goalTitle.scrollHeight > goalTitle.clientHeight)) problems.push("the Agents card's objective is not clamped");
  const sideCard = box(document.querySelector(".reviewer-goal"));
  for (const button of document.querySelectorAll(".reviewer-goal button")) {
    if (box(button).right > sideCard.right + 1) problems.push(`"${button.textContent.slice(0, 12)}" runs past the Agents card`);
  }
  return problems;
}

for (const [label, width] of [["desktop", 760], ["phone", 390]]) {
  for (const theme of ["light", "dark"]) {
    test(`${label} ${theme}: goal lines, cards and steps keep their shape`, async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: width + 400, height: 900 } });
        await page.setContent(
          `<!doctype html><html data-theme="${theme}"><head><style>${css}${STILL}</style></head>
            <body style="display:flex;gap:20px;align-items:flex-start">
            <div class="chat-thread" data-surface="thread" style="width:${width}px">${transcript}</div>
            <div class="right-rail-body" style="width:340px">${panel}</div></body></html>`,
          { waitUntil: "load" }
        );
        assert.deepEqual(await page.evaluate(measure), []);
      } finally {
        await browser.close();
      }
    });
  }
}
