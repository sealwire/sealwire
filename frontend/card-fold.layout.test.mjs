// Measured in a browser: a folded value's leftover lines are only clipped while its box
// stays as short as the fold, and only layout says how tall the box ended up.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { ConversationEmptyState } from "./shared/conversation.js";
import { ReviewerPanel } from "./shared/reviewer-panel.js";
import { TranscriptContent } from "./shared/transcript-react.js";

const h = React.createElement;
// Same order as the app's @imports, which a <style> block cannot follow.
const css = ["conversation.css", "review-cards.css", "delegate-cards.css", "styles.css"]
  .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))
  .join("\n");
const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; }
  .chat-message { content-visibility: visible !important; }`;

const LONG = "这句话写得很长，长到在卡片里一定会换行，折叠以后只该露出开头的两行，后面的都要藏好。";
const list = (tag) => Array.from({ length: 5 }, (_, i) => `- ${tag} ${i + 1}：${i % 2 ? LONG : "短的一条。"}`).join("\n");
const paragraphs = (tag) => Array.from({ length: 3 }, (_, i) => `${tag} ${i + 1}。${LONG}`).join("\n\n");
// Headings long enough to wrap in the label column, as agents write them.
// It opens the way a delegate brief does: a long to-do list before the first heading.
const SUMMARY = [
  `结论：没有 blocker。${LONG}`,
  "",
  "要做的：",
  list("开头"),
  "  - 嵌套的一条。",
  "  - 嵌套的另一条。",
  "## 1. joined 其他情况（已逐一验证，行为正确或和旧版一致）",
  list("列表"),
  "## Where the remote ask handler reads its text from, and why it matters here",
  paragraphs("段落"),
  "## 已经确认过的事情，以及还没有确认、需要你去看的事情",
  `只有一段。${LONG}${LONG}${LONG}`,
].join("\n");
const PLAIN = `开头一句话。\n\n${list("无标题")}\n\n${paragraphs("无标题段落")}`;

const INSTRUCTION = "\n\n---\nAnother agent asked for this. When you are done, call the `report_back` tool.";
const ask = (extra = {}) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  asker_title: "Selection Ask",
  asker_provider: "claude_code",
  peer_thread_id: "peer",
  peer_provider: "codex",
  task: "问下 Codex",
  title: "继续审查同一个 worktree",
  instruction: INSTRUCTION,
  status: "working",
  answered_with_tool: false,
  delivered: false,
  asked_at: 1_790_000_000,
  sent_at: 1_790_000_030,
  ...extra,
});
const answered = (answer) =>
  ask({ status: "done", delivered: true, answered_with_tool: true, answer, finished_at: 1_790_000_160 });
const user = (id, text, injection) => ({ item_id: id, kind: "user_text", status: "completed", text, injection });
const agent = (id, text, injection) => ({ item_id: id, kind: "agent_text", status: "completed", text, injection });
const reportBack = (answer) => ({
  item_id: "tool",
  kind: "tool_call",
  status: "completed",
  text: "",
  tool: { item_type: "mcpToolCall", name: "report_back", title: "report_back", input_preview: JSON.stringify({ answer }) },
  injection: { kind: "delegate_reported", delegate: [answered(answer)] },
});
const handover = {
  id: "handover-1",
  source_thread_id: "src",
  source_title: "Fix goal gate",
  source_provider: "claude_code",
  target_thread_id: "tgt",
  target_title: "Selection Ask remote",
  target_provider: "codex",
  instruction: "\n\n---\nThat work is now yours.",
  status: "done",
  created_at: 1_790_000_000,
  updated_at: 1_790_000_000,
};
const round = {
  round: 1,
  reviewer_thread_id: "rev",
  verdict: "needs_changes",
  findings: [
    { severity: "high", text: `${LONG}${LONG}`, location: "crates/relay-server/src/state/relay/background.rs:1234" },
    { severity: "low", text: `${LONG}${LONG}${LONG}`, location: null },
  ],
  findings_total: 2,
  fixed: [],
  fixed_total: 0,
  base_sha: "3a0e1f2aa4b5c6d7",
  candidate_sha: "7be04d1bb4b5c6d7",
  files: 6,
  insertions: 84,
  deletions: 41,
  change: `${LONG}${LONG}`,
  started_at: 1_790_000_000,
  finished_at: 1_790_000_124,
  delivered: true,
};
const review = {
  id: "review-1",
  round: 1,
  max_rounds: 1,
  parent_thread_id: "parent",
  parent_title: "Fix goal gate",
  parent_provider: "claude_code",
  reviewer_thread_id: "rev",
  reviewer_provider: "codex",
  status: "complete",
  rounds: [round],
};

const transcript = (entries) => renderToStaticMarkup(h(TranscriptContent, { entries, options: { provider: "claude_code" } }));
const CASES = {
  "Delegated to": transcript([
    user("req", "P", { kind: "delegate_request", delegate: [ask()] }),
    agent("brief", `${ask().title}\n\n${SUMMARY}`, { kind: "delegate_brief", delegate: [ask()] }),
  ]),
  "Task from": transcript([user("task", `${ask().title}\n\n${SUMMARY}${INSTRUCTION}`, { kind: "delegate_task", delegate: [ask()] })]),
  "Codex answered": transcript([
    user("wake", "W", { kind: "delegate_answer", delegate: [answered(SUMMARY)] }),
    user("wake-plain", "W", { kind: "delegate_answer", delegate: [{ ...answered(PLAIN), id: "ask-2" }] }),
  ]),
  "Reported back": transcript([user("task", `B${INSTRUCTION}`, { kind: "delegate_task", delegate: [answered(SUMMARY)] }), reportBack(SUMMARY)]),
  "Reported back, no headings": transcript([user("task", `B${INSTRUCTION}`, { kind: "delegate_task", delegate: [answered(PLAIN)] }), reportBack(PLAIN)]),
  "Handed over": transcript([
    user("u1", "PROMPT", { kind: "handover_request", handover }),
    agent("a1", SUMMARY, { kind: "handover_summary", handover }),
  ]),
  "Picked up": transcript([user("b1", SUMMARY + handover.instruction, { kind: "handover_brief", handover })]),
  "Review result": transcript([user("r1", "P", { kind: "review_result", review })]),
  "Review brief": transcript([user("r2", "P", { kind: "review_brief", review: { ...review, status: "running" } })]),
  "Agents panel": renderToStaticMarkup(
    h(ReviewerPanel, {
      goal: { objective: `${LONG}${LONG}${LONG}`, status: "complete_claimed", outcome: `${LONG}\n\n${LONG}\n\n${LONG}`, turns: 7, max_turns: 20 },
      asks: [{ ...answered(`${LONG}${LONG}${LONG}`), message: `${LONG}${LONG}`, asker_thread_id: "me", updated_at: 10 }],
      parentThreadId: "me",
      reviewJobs: [],
      canRequest: false,
      onOpenThread: () => {},
    })
  ),
  "Empty session": renderToStaticMarkup(h(ConversationEmptyState, { title: "Session", clampDetails: true, details: [`${LONG}${LONG}${LONG}`] })),
};

// Found by computed style rather than class, so a fold added to one of these cards is checked too.
function foldProblems() {
  const problems = [];
  const clamped = [...document.querySelectorAll("*")].filter((el) => getComputedStyle(el).webkitLineClamp !== "none");
  for (const box of clamped) {
    const edge = box.getBoundingClientRect();
    const lines = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const top = Math.max(rect.top, edge.top);
        const bottom = Math.min(rect.bottom, edge.bottom);
        if (rect.width > 1 && bottom - top > 3) {
          lines.push({ node, text: node.data.trim().slice(0, 16), top, bottom, left: rect.left, right: rect.right });
        }
      }
    }
    const where = `${box.closest("[data-case]").dataset.case} · "${lines[0]?.text || box.textContent.slice(0, 16)}"`;
    const rows = [];
    for (const line of lines) {
      if (!rows.some((top) => Math.abs(top - line.top) < 6)) rows.push(line.top);
    }
    const allowed = Number(getComputedStyle(box).webkitLineClamp);
    if (rows.length > allowed) {
      problems.push(`${where}: shows ${rows.length} lines, folded to ${allowed}`);
    }
    // A text node reports its line twice where the fold's ellipsis cuts it, so only other nodes count.
    const drawnOver = lines.find((a) =>
      lines.some((b) => b.node !== a.node
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3
        && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3)
    );
    if (drawnOver) {
      problems.push(`${where}: "${drawnOver.text}" is drawn over other text`);
    }
  }
  return problems;
}

for (const [label, width] of [["desktop", 900], ["phone", 390]]) {
  test(`${label}: a folded card value shows only its first lines, none drawn over another`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: width + 40, height: 900 } });
      const body = Object.entries(CASES)
        .map(([name, markup]) => `<section data-case="${name}">${markup}</section>`)
        .join("");
      await page.setContent(
        `<!doctype html><html data-theme="light"><head><style>${css}${STILL}</style></head><body>
          <div class="chat-thread" style="width:${width}px">${body}</div></body></html>`,
        { waitUntil: "load" }
      );
      const counted = await page.evaluate(() =>
        [...document.querySelectorAll("[data-case]")].map((section) => [
          section.dataset.case,
          [...section.querySelectorAll("*")].filter((el) => getComputedStyle(el).webkitLineClamp !== "none").length,
        ])
      );
      for (const [name, folds] of counted) {
        assert.ok(folds > 0, `${name} rendered no folded value, so it checks nothing`);
      }
      assert.deepEqual(await page.evaluate(foldProblems), []);
    } finally {
      await browser.close();
    }
  });
}
