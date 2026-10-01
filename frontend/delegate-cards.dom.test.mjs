// The brief line's Cancel carries what the surface needs to act, as drawn.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out: a folded value "overflows" when it holds more than a short line.
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 40 });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
  get() {
    return this.textContent.length > 40 ? 120 : 20;
  },
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");
const { resolveTranscriptAction } = await import("./shared/transcript-interactions.js");

const h = React.createElement;
const ask = (extra) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  asker_provider: "claude_code",
  peer_thread_id: "peer",
  peer_provider: "codex",
  task: "ask codex",
  title: "Where does the text come from?",
  instruction: "",
  status: "working",
  delivered: false,
  asked_at: 1,
  ...extra,
});
const request = (extra) => ({
  item_id: "req",
  kind: "user_text",
  status: "completed",
  text: "prompt",
  injection: { kind: "delegate_request", delegate: [ask(extra)] },
});

async function mount(entries) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));
  return { container, unmount: () => act(async () => root.unmount()) };
}

test("prepending the request keeps the marked brief's card", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const delegated = ask({ sent_at: 10 });
  const brief = {
    item_id: "brief",
    kind: "agent_text",
    status: "completed",
    text: "Where does the text come from?\n\nInspect the remote Ask handler.",
    injection: { kind: "delegate_brief", delegate: [delegated] },
  };
  const render = (entries) => act(async () => root.render(h(TranscriptContent, {
    entries,
    options: { provider: "claude_code" },
  })));
  try {
    await render([brief]);
    const card = container.querySelector(".delegate-card");
    assert.ok(card);

    await render([request({ sent_at: 10 }), brief]);

    assert.equal(container.querySelectorAll(".delegate-card").length, 1);
    assert.ok(container.querySelector(".delegate-card") === card, "the older request does not replace the card");
    assert.equal(container.querySelectorAll(".handover-command").length, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Cancel on the brief line stops the asker's own turn", async () => {
  const { container, unmount } = await mount([
    request({ peer_thread_id: "" }),
  ]);
  const resolved = resolveTranscriptAction(container.querySelector('[data-delegate-action="cancel"]'));
  assert.equal(resolved.kind, "delegateAction");
  assert.equal(resolved.threadId, "asker");
  assert.equal(container.querySelectorAll("[data-delegate-action]").length, 1, "the only button a card has");
  await unmount();
});

// A brief puts its whole to-do list before its one `## Context` heading.
test("the part of a brief before its first heading folds and opens like the rest", async () => {
  const lead = [
    "Review the uncommitted change in the worktree and report correctness bugs.",
    "",
    "What to do:",
    "- Read AGENTS.md and CLAUDE.md in the worktree first.",
    "- Look for real defects in the parser, the sort and the picker.",
    "- You are done when every changed file has been checked.",
  ].join("\n");
  const brief = `${ask().title}\n\n${lead}\n\n## Context\nThe user asked for two things.`;
  const cards = {
    asked: [request({ sent_at: 10 }), { item_id: "brief", kind: "agent_text", status: "completed", text: brief }],
    task: [{
      item_id: "task",
      kind: "user_text",
      status: "completed",
      text: brief,
      injection: { kind: "delegate_task", delegate: [ask({ sent_at: 10 })] },
    }],
  };
  for (const [name, entries] of Object.entries(cards)) {
    const { container, unmount } = await mount(entries);
    try {
      const opening = container.querySelector(".delegate-card .handover-section.is-untitled .handover-section-value");
      assert.ok(opening?.textContent.includes("What to do"), `${name}: the opening is drawn`);
      assert.ok(opening.classList.contains("is-clamped"), `${name}: the opening is folded`);
      assert.equal(opening.getAttribute("role"), "button", `${name}: it has no heading to press, so it is the button`);

      await act(async () => opening.click());
      assert.ok(!opening.classList.contains("is-clamped"), `${name}: pressing it opens it`);
    } finally {
      await unmount();
    }
  }
});

test("Enter or Space on a link inside folded text is the link's, and Enter on the text opens it", async () => {
  const lead = "Read [the review notes](https://example.com/review) and then check every changed module.";
  const briefs = {
    headed: `${ask().title}\n\n${lead}\n\n## Context\nThe user asked for two things.`,
    plain: `${ask().title}\n\n${lead}`,
  };
  for (const [name, brief] of Object.entries(briefs)) {
    const { container, unmount } = await mount([
      request({ sent_at: 10 }),
      { item_id: "brief", kind: "agent_text", status: "completed", text: brief },
    ]);
    try {
      const value = container.querySelector(".delegate-card .card-fold");
      const link = value?.querySelector("a");
      assert.ok(link, `${name}: the link is drawn`);
      for (const key of ["Enter", " "]) {
        const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        await act(async () => link.dispatchEvent(event));
        assert.equal(event.defaultPrevented, false, `${name}: ${JSON.stringify(key)} still reaches the link`);
        assert.ok(value.classList.contains("is-clamped"), `${name}: ${JSON.stringify(key)} on the link leaves the text folded`);
      }

      const own = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => value.dispatchEvent(own));
      assert.ok(!value.classList.contains("is-clamped"), `${name}: Enter on the text itself opens it`);
    } finally {
      await unmount();
    }
  }
});
