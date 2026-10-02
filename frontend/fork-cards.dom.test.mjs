// A replayed fork's first message is drawn as where it came from; a native fork gets a line
// where its copied history ends.
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
    return this.textContent.length > 80 ? 120 : 20;
  },
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");
const { carriedText } = await import("./shared/fork-card.js");

const h = React.createElement;
const REPLAYED = "You are starting from a forked agent session.\nFork metadata:\n- Source provider: claude_code";

function fork(extra = {}) {
  return {
    id: "fork-1",
    source_thread_id: "src",
    source_title: "Fix logout after 15 minutes",
    source_provider: "claude_code",
    target_provider: "codex",
    note: "Try an httpOnly cookie instead.",
    branch_point: {
      speaker: "agent",
      text: "I moved the refresh into the interceptor and all 14 auth tests pass. The race is still there.",
    },
    carried: { total: 128, full: 16, condensed: 112, dropped: 0 },
    created_at: 1_700_000_000,
    ...extra,
  };
}

function brief(card) {
  return {
    row_id: "u1",
    kind: "user_text",
    status: "completed",
    text: REPLAYED,
    injection: { kind: "fork_brief", fork: card },
  };
}

async function render(entries) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "codex" } })));
  return {
    container,
    rows: () =>
      [...container.querySelectorAll(".fork-card .handover-section")].map((row) => [
        row.querySelector(".handover-section-label").textContent,
        row.querySelector(".handover-section-value").textContent,
      ]),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the card stands in for the context the relay wrote, and none of it is shown", async () => {
  const view = await render([brief(fork())]);
  try {
    const card = view.container.querySelector(".fork-card");
    assert.ok(card, "drawn as a card");
    assert.ok(!view.container.textContent.includes("You are starting from a forked agent session"));
    assert.ok(!view.container.querySelector(".chat-message-user .message-card"), "no user bubble");
    assert.equal(card.querySelector(".handover-card-kicker").textContent, "Forked from Claude");
    assert.equal(card.querySelector(".handover-card-title").textContent, "Fix logout after 15 minutes");
    assert.deepEqual(view.rows(), [
      ["Branched at", `Claude: ${fork().branch_point.text}`],
      ["Your note", "Try an httpOnly cookie instead."],
      ["Carried over", "128 steps — the last 16 as written, the 112 before them cut to a line each."],
    ]);
    const link = card.querySelector("[data-open-thread-id]");
    assert.equal(link.getAttribute("data-open-thread-id"), "src");
    assert.equal(link.textContent, "Source thread");
  } finally {
    await view.unmount();
  }
});

test("with nothing typed there is no note row, and a lost source leaves no link", async () => {
  const view = await render([brief(fork({ note: "", source_thread_id: "", source_title: undefined }))]);
  try {
    assert.deepEqual(
      view.rows().map(([label]) => label),
      ["Branched at", "Carried over"]
    );
    const card = view.container.querySelector(".fork-card");
    assert.equal(card.querySelector(".handover-card-title").textContent, "Another session");
    assert.ok(!card.querySelector("[data-open-thread-id]"));
    assert.ok(!card.querySelector(".handover-card-foot"), "no empty footer");
  } finally {
    await view.unmount();
  }
});

test("the quoted message folds to two lines and opens from its label", async () => {
  const view = await render([brief(fork())]);
  try {
    const row = view.container.querySelector(".fork-card .handover-section");
    const label = row.querySelector("button.handover-section-label");
    const value = row.querySelector(".handover-section-value");
    assert.ok(label, "a long quote can be opened");
    assert.ok(value.classList.contains("is-clamped"));
    await act(async () => label.click());
    assert.ok(!value.classList.contains("is-clamped"));
    assert.equal(label.getAttribute("aria-expanded"), "true");
  } finally {
    await view.unmount();
  }
});

test("a native fork draws one line right after the row its copy ended on", async () => {
  const entries = [
    { row_id: "u0", kind: "user_text", status: "completed", text: "Why the logout?" },
    {
      row_id: "a0",
      kind: "agent_text",
      status: "completed",
      text: "The race.",
      injection: { kind: "fork_start", fork: fork({ carried: undefined, note: "" }) },
    },
    { row_id: "u1", kind: "user_text", status: "completed", text: "Try cookies." },
  ];
  const view = await render(entries);
  try {
    const dividers = view.container.querySelectorAll(".fork-divider");
    assert.equal(dividers.length, 1);
    const divider = dividers[0];
    assert.ok(divider.textContent.startsWith("Forked from Fix logout after 15 minutes"));
    assert.equal(divider.querySelector("[data-open-thread-id]").getAttribute("data-open-thread-id"), "src");
    assert.ok(!view.container.querySelector(".fork-card"), "no card: nothing long was sent");
    const order = [...view.container.querySelectorAll(".fork-divider, .message-body")].map((node) =>
      node.classList.contains("fork-divider") ? "divider" : node.textContent.trim()
    );
    assert.deepEqual(order, ["Why the logout?", "The race.", "divider", "Try cookies."]);
  } finally {
    await view.unmount();
  }
});

test("the carried line says what the replay kept, in plain words", () => {
  assert.equal(carriedText(null), null);
  assert.equal(carriedText({ total: 0, full: 0, condensed: 0, dropped: 0 }), null);
  assert.equal(carriedText({ total: 6, full: 6, condensed: 0, dropped: 0 }), "All 6 steps, as written.");
  assert.equal(carriedText({ total: 1, full: 1, condensed: 0, dropped: 0 }), "The one step, as written.");
  assert.equal(
    carriedText({ total: 17, full: 16, condensed: 1, dropped: 0 }),
    "17 steps — the last 16 as written, the 1 before it cut to a line each."
  );
  assert.equal(
    carriedText({ total: 300, full: 16, condensed: 120, dropped: 164 }),
    "300 steps — the last 16 as written, the 120 before them cut to a line each, the oldest 164 left out to fit."
  );
});
