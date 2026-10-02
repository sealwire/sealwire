// A card whose body the relay sent short loads the rest from its row when opened,
// keeps showing what it has meanwhile, and lets a failed load be tried again.
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

const h = React.createElement;

const ask = (extra) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  asker_provider: "claude_code",
  peer_thread_id: "peer",
  peer_provider: "codex",
  task: "Check it…",
  title: "Where does the text come from?",
  instruction: "",
  status: "working",
  delivered: false,
  asked_at: 1,
  sent_at: 2,
  ...extra,
});

const callRow = (askExtra) => ({
  row_id: "call",
  item_id: "call",
  kind: "tool_call",
  status: "completed",
  tool: { item_type: "mcpToolCall", name: "delegate" },
  injection: { kind: "delegate_call", delegate: [ask(askExtra)] },
});

async function mount(entries, options = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const loads = [];
  const render = (nextEntries, nextOptions = {}) =>
    act(async () =>
      root.render(
        h(TranscriptContent, {
          entries: nextEntries,
          options: {
            provider: "claude_code",
            onLoadEntryDetail: (rowId) => loads.push(rowId),
            ...options,
            ...nextOptions,
          },
        })
      )
    );
  await render(entries);
  return {
    container,
    loads,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const press = (node) => act(async () => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));

test("a short-looking brief the relay cut still opens, and opening it loads the rest once", async () => {
  const listed = [callRow({ task_clipped: true })];
  const view = await mount(listed);
  try {
    const text = view.container.querySelector(".delegate-card-text");
    assert.ok(text.classList.contains("is-togglable"), "the relay said there is more, so it opens");
    await press(text);
    assert.deepEqual(view.loads, ["call"]);

    await view.render(listed, { loadingItemIds: new Set(["call"]) });
    assert.ok(view.container.querySelector(".delegate-card [data-card-body-loading]"), "it says it is loading");
    assert.match(view.container.querySelector(".delegate-card-text").textContent, /Check it/, "and keeps what it has");

    const whole = "Check it all: every retry branch, the timeout, and the log line.";
    await view.render(
      [callRow({ task_clipped: true, status: "done", finished_at: 9 })],
      { detailEntries: new Map([["call", callRow({ task: whole })]]) }
    );
    const card = view.container.querySelector(".delegate-card");
    assert.match(card.textContent, /every retry branch/);
    assert.match(card.textContent, /Codex answered/, "the newer copy still says how it went");
    assert.equal(card.querySelector("[data-card-body-loading]"), null);
    assert.deepEqual(view.loads, ["call"], "nothing more to ask for");
  } finally {
    await view.unmount();
  }
});

test("a failed load says so and the card can try again", async () => {
  const listed = [callRow({ task_clipped: true })];
  const view = await mount(listed);
  try {
    await press(view.container.querySelector(".delegate-card-text"));
    await view.render(listed, { detailFailedItemIds: new Set(["call"]) });
    const retry = view.container.querySelector("[data-card-body-retry]");
    assert.ok(retry, "a way to try again");
    await press(retry);
    assert.deepEqual(view.loads, ["call", "call"]);
  } finally {
    await view.unmount();
  }
});

test("an answer cut short offers the whole of it even when every section shows", async () => {
  const answerRow = {
    row_id: "answer",
    item_id: "answer",
    kind: "user_text",
    status: "completed",
    text: "wake",
    injection: {
      kind: "delegate_answer",
      delegate: [ask({ status: "done", answer: "## Finding\nThe loop retr…", answer_clipped: true, finished_at: 5 })],
    },
  };
  const view = await mount([answerRow]);
  try {
    const more = [...view.container.querySelectorAll(".handover-card-more")].find((node) =>
      /whole answer/.test(node.textContent)
    );
    assert.ok(more, "the button is there though nothing is hidden on screen");
    await press(more);
    assert.deepEqual(view.loads, ["answer"]);
  } finally {
    await view.unmount();
  }
});

const finding = (index, extra) => ({ severity: "medium", text: `Finding ${index}`, ...extra });

const reviewRow = (round, extra) => ({
  row_id: "review",
  item_id: "review",
  kind: "user_text",
  status: "completed",
  text: "findings",
  injection: {
    kind: "review_result",
    review: {
      id: "r",
      round: 1,
      max_rounds: 1,
      parent_thread_id: "asker",
      parent_provider: "claude_code",
      reviewer_thread_id: "reviewer",
      reviewer_provider: "codex",
      status: "complete",
      rounds: [{
        round: 1,
        reviewer_thread_id: "reviewer",
        verdict: "needs_changes",
        findings_total: 5,
        fixed: [],
        fixed_total: 0,
        started_at: 1,
        finished_at: 4,
        ...round,
      }],
      ...extra,
    },
  },
});

test("a review that held findings back loads them all when asked for", async () => {
  const listed = [reviewRow({ findings: [1, 2].map((i) => finding(i)) }, { findings_clipped: true })];
  const view = await mount(listed);
  try {
    const showAll = [...view.container.querySelectorAll(".handover-card-more")].find((node) =>
      /Show all findings/.test(node.textContent)
    );
    assert.ok(showAll, "the relay held some back, so there is more to show");
    await press(showAll);
    assert.deepEqual(view.loads, ["review"]);

    await view.render(listed, {
      detailEntries: new Map([["review", reviewRow({ findings: [1, 2, 3, 4, 5].map((i) => finding(i)) })]]),
    });
    assert.equal(view.container.querySelectorAll(".review-finding").length, 5);
    assert.doesNotMatch(view.container.textContent, /more in the reviewer's thread/);
  } finally {
    await view.unmount();
  }
});

test("a finding cut short opens though it fits, and opening it loads its row", async () => {
  const view = await mount([
    reviewRow({ findings: [finding(1, { text: "Short but cut…", clipped: true })], findings_total: 1 }, { findings_clipped: true }),
  ]);
  try {
    const text = view.container.querySelector(".review-finding-text");
    assert.ok(text.classList.contains("is-togglable"));
    await press(text);
    assert.deepEqual(view.loads, ["review"]);
  } finally {
    await view.unmount();
  }
});

const goalRow = (extra) => ({
  row_id: "goal",
  item_id: "goal",
  kind: "tool_call",
  status: "completed",
  tool: { item_type: "mcpToolCall", name: "goal_complete" },
  injection: {
    kind: "goal_settled",
    goal_settled: {
      goal_id: "g",
      thread_id: "asker",
      seq: 1,
      status: "complete_claimed",
      objective: "Ship it",
      turns: 2,
      max_turns: 5,
      provider: "claude_code",
      steps: [],
      report: "Done: the par…",
      report_clipped: true,
      settled_at: 3,
      ...extra,
    },
  },
});

test("the full report loads when it is opened, and is whole once it has", async () => {
  const listed = [goalRow()];
  const view = await mount(listed);
  try {
    const open = [...view.container.querySelectorAll(".handover-card-more")].find((node) =>
      /Full report/.test(node.textContent)
    );
    await press(open);
    assert.deepEqual(view.loads, ["goal"]);

    await view.render(listed, { detailEntries: new Map([["goal", goalRow({ report: "Done: the parser and the sort.", report_clipped: false })]]) });
    assert.match(view.container.querySelector(".goal-card-report").textContent, /the parser and the sort/);
  } finally {
    await view.unmount();
  }
});

test("a blocked goal's reason cut short offers the rest under it", async () => {
  const view = await mount([goalRow({ status: "blocked", report: "It needs a key that…" })]);
  try {
    const more = [...view.container.querySelectorAll(".handover-card-more")].find((node) =>
      /full report/i.test(node.textContent)
    );
    assert.ok(more);
    await press(more);
    assert.deepEqual(view.loads, ["goal"]);
  } finally {
    await view.unmount();
  }
});

test("a handover summary cut short loads the rest from the row that wrote it", async () => {
  const summary = {
    row_id: "summary",
    item_id: "summary",
    kind: "agent_text",
    status: "completed",
    text: "## Goal\nShip it\n\n## State\nHalf do…",
    injection: {
      kind: "handover_summary",
      text_clipped: true,
      handover: { id: "h", source_provider: "claude_code", target_provider: "codex", status: "done", note: "", instruction: "", created_at: 1, updated_at: 2 },
    },
  };
  const view = await mount([summary]);
  try {
    const more = [...view.container.querySelectorAll(".handover-card-more")].find((node) =>
      /Show full summary/.test(node.textContent)
    );
    assert.ok(more, "two sections show, but the relay said there is more");
    await press(more);
    assert.deepEqual(view.loads, ["summary"]);
  } finally {
    await view.unmount();
  }
});

test("a finding opened to load its rest stays open once the rest arrives", async () => {
  const listed = [
    reviewRow({ findings: [finding(1, { text: "Short but cut…", clipped: true })], findings_total: 1 }, { findings_clipped: true }),
  ];
  const view = await mount(listed);
  try {
    await press(view.container.querySelector(".review-finding-text"));
    const whole = "Short but cut no more: the retry loop never backs off when the server says 503.";
    await view.render(listed, {
      detailEntries: new Map([["review", reviewRow({ findings: [finding(1, { text: whole })], findings_total: 1 })]]),
    });
    const text = view.container.querySelector(".review-finding-text");
    assert.equal(text.textContent, whole);
    assert.equal(text.getAttribute("aria-expanded"), "true", "still the row that was opened");
    assert.equal(text.classList.contains("is-clamped"), false);
  } finally {
    await view.unmount();
  }
});
