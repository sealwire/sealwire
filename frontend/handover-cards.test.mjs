// Design 23a/23b: a handover's two injected prompts are drawn as one card at each end,
// never as bubbles the person did not type.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { parseHandoverSections } from "./shared/handover-card.js";

const h = React.createElement;
const PROMPT = "This work is being handed over to another agent. SECRET-PROMPT";
const INSTRUCTION = "\n\n---\nThat work is now yours. CONTINUE-INSTRUCTION";
const SUMMARY = [
  "## Goal",
  "Selection Ask quoting.",
  "",
  "## Current state",
  "Five of five tests pass.",
  "",
  "## Completed work",
  "Wired the toolbar.",
  "",
  "## Remaining work",
  "HIDDEN-REMAINING remote handler.",
  "",
  "## Files changed",
  "- frontend/a.js",
].join("\n");

const handover = (extra = {}) => ({
  id: "handover-1",
  source_thread_id: "src",
  source_title: "Fix goal gate",
  source_provider: "claude_code",
  target_thread_id: "tgt",
  target_title: "Selection Ask remote",
  target_provider: "codex",
  note: "going to do the review part",
  instruction: INSTRUCTION,
  status: "done",
  created_at: 1_790_000_000,
  updated_at: 1_790_000_000,
  ...extra,
});
const user = (id, text, extra = {}) => ({ item_id: id, kind: "user_text", status: "completed", text, ...extra });
const agent = (id, text, extra = {}) => ({ item_id: id, kind: "agent_text", status: "completed", text, ...extra });
const request = (extra = {}) =>
  user("u1", PROMPT, { injection: { kind: "handover_request", handover: handover(extra) } });
const brief = () =>
  user("b1", SUMMARY + INSTRUCTION, { injection: { kind: "handover_brief", handover: handover() } });

function render(entries, options = {}) {
  return renderToStaticMarkup(h(TranscriptContent, { entries, options: { provider: "claude_code", ...options } }));
}

test("the source shows what was typed and a Handed over card instead of the prompt and reply", () => {
  const markup = render([user("u0", "earlier"), agent("a0", "ok"), request(), agent("a1", SUMMARY)]);

  assert.doesNotMatch(markup, /SECRET-PROMPT/, "the injected prompt is not the person's message");
  assert.match(markup, /\/handover going to do the review part/);
  assert.match(markup, /Handed over/);
  assert.match(markup, /to Codex/);
  assert.match(markup, /Selection Ask remote/);
  for (const heading of ["Goal", "Current state", "Completed work"]) {
    assert.match(markup, new RegExp(`>${heading}<`));
  }
  assert.match(markup, /Selection Ask quoting\./);
  assert.doesNotMatch(markup, /HIDDEN-REMAINING/, "past the first three headings is folded");
  assert.match(markup, /Show full summary · 2 more sections/);
  assert.match(markup, /Codex picked it up/);
  assert.match(markup, /data-open-thread-id="tgt"/);
  assert.doesNotMatch(
    markup,
    /data-transcript-entry-id="a1"/,
    "the summary reply lives in the card, not beside it"
  );
  assert.match(markup, /data-transcript-entry-id="a0"/, "rows outside the handover turn are untouched");
});

test("while the summary is written the source shows one line, not the reply streaming in", () => {
  const markup = render([request({ status: "working" }), agent("a1", "PARTIAL-SUMMARY", { status: "running" })]);

  assert.match(markup, /Preparing handover/);
  assert.match(markup, /Claude is summarizing this thread for Codex/);
  assert.doesNotMatch(markup, /PARTIAL-SUMMARY/);
  assert.doesNotMatch(markup, /SECRET-PROMPT/);
});

test("a failed handover says why and leaves whatever was written readable", () => {
  const markup = render([request({ status: "failed", error: "that agent went away" }), agent("a1", SUMMARY)]);

  assert.match(markup, /Handover did not finish/);
  assert.match(markup, /that agent went away/);
  assert.match(markup, /HIDDEN-REMAINING/, "the reply is shown as it is, so nothing is lost");
  assert.doesNotMatch(markup, /SECRET-PROMPT/);
});

test("the target shows a Picked up card with the summary and not the instruction", () => {
  const markup = render([brief(), agent("a2", "Taking it from here.")], { provider: "codex" });

  assert.match(markup, /Picked up from Claude/);
  assert.match(markup, /Fix goal gate/);
  assert.match(markup, /Selection Ask quoting\./);
  assert.doesNotMatch(markup, /CONTINUE-INSTRUCTION/, "the instruction is only in Sent to Codex");
  assert.match(markup, /Sent to Codex/);
  assert.match(markup, /data-open-thread-id="src"/);
  assert.match(markup, /Taking it from here\./, "the agent's own reply follows as usual");
});

test("a page carries a row's mark into the held window, and a newer status replaces it", async () => {
  const { createMergedTranscriptHydrationPagePatch } = await import("./shared/transcript-hydration-store.js");
  const state = {
    transcriptHydrationEntries: new Map([["u1", { ...request({ status: "working" }), content_state: "full" }]]),
    transcriptHydrationOrder: ["u1"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "src|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "src",
  };
  const page = { thread_id: "src", prev_cursor: null, entries: [{ ...request(), content_state: "full" }] };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });

  assert.equal(patch.transcriptHydrationEntries.get("u1").injection?.handover.status, "done");
});

test("a page holding a handover still under way is not cached as settled", async () => {
  const { isCacheablePage } = await import("./shared/caching-transcript-fetcher.js");
  const page = (status) => ({ thread_id: "src", entries: [request({ status })] });

  assert.equal(isCacheablePage(page("working"), "src"), false);
  assert.equal(isCacheablePage(page("done"), "src"), true);
});

test("the open thread's snapshot moves its card from working to done", async () => {
  const { prepareTranscriptHydrationState } = await import("./shared/transcript-hydration-store.js");
  const working = { ...request({ status: "working" }), turn_id: "turn-1", tool: null };
  const state = {
    session: { active_thread_id: "src", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "src", transcript_revision: 10 },
    transcriptHydrationEntries: new Map([["u1", working]]),
    transcriptHydrationOrder: ["u1"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "src|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "src",
  };
  const snapshot = {
    active_thread_id: "src",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [{ ...request(), turn_id: "turn-1", tool: null }],
  };

  Object.assign(state, prepareTranscriptHydrationState(state, snapshot).patch);

  assert.equal(state.transcriptHydrationEntries.get("u1").injection?.handover.status, "done");
});

test("a line before the first heading does not use up one of the three shown", () => {
  const markup = render([
    request(),
    agent("a1", `Here is the handover.\n\n${SUMMARY}`),
  ]);

  for (const heading of ["Goal", "Current state", "Completed work"]) {
    assert.match(markup, new RegExp(`>${heading}<`));
  }
  assert.match(markup, /Show full summary · 2 more sections/);
});

const sections = (text) => parseHandoverSections(text).map(({ title, body }) => [title, body]);

test("a summary is cut at its ## headings, the form the prompt asks for", () => {
  assert.deepEqual(sections("## Goal\nShip it.\n\n## Current state\nHalf done.\nThere is one risk: Windows."), [
    ["Goal", "Ship it."],
    ["Current state", "Half done.\nThere is one risk: Windows."],
  ]);
  assert.deepEqual(sections("Preamble line.\n## 目标\n完成交接"), [
    ["", "Preamble line."],
    ["目标", "完成交接"],
  ]);
});

test("smaller headings stay inside the largest ones, and a lone # titles the document", () => {
  assert.deepEqual(sections("## Completed work\n### Backend\nEndpoint done.\n### Frontend\nCard done."), [
    ["Completed work", "### Backend\nEndpoint done.\n### Frontend\nCard done."],
  ]);
  assert.deepEqual(sections("# Handover Summary\n## Goal\nShip it.\n## Current state\nHalf done."), [
    ["Goal", "Ship it."],
    ["Current state", "Half done."],
  ]);
  assert.deepEqual(sections("# Handover Summary\nJust prose."), [["", "Just prose."]]);
});

test("any other way of writing headings is left as text", () => {
  for (const text of [
    "Goal — Ship it.\nCurrent state — Half done.",
    "**Goal:** Ship it.\n**Current state:** Half done.",
    "目标：完成交接\n当前状态：已更新",
  ]) {
    assert.deepEqual(sections(text), [["", text]]);
  }
});

test("a summary without ## headings shows its first lines and folds the rest", () => {
  const text = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of the summary.`).join("\n");
  const markup = render([request(), agent("a1", text)]);

  assert.match(markup, /Line 1 of the summary\./);
  assert.doesNotMatch(markup, /Line 12 of the summary\./);
  assert.match(markup, /Show full summary/);
});

test("a short summary without headings is shown whole", () => {
  const markup = render([request(), agent("a1", "All done; nothing left.")]);

  assert.match(markup, /All done; nothing left\./);
  assert.doesNotMatch(markup, /Show full summary/);
});

test("a # inside a code block is code, not a heading", () => {
  const comment = "Run this:\n```sh\n# build the frontend\nnpm run build\n```\nThen verify it.";
  assert.deepEqual(sections(comment), [["", comment]]);

  const steps = "## Tests\nRun this:\n```sh\n## install\nnpm ci\n```\n## Next\nShip it.";
  assert.deepEqual(sections(steps), [
    ["Tests", "Run this:\n```sh\n## install\nnpm ci\n```"],
    ["Next", "Ship it."],
  ]);
});
