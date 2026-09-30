// An agent's flagship request is decided on its Agents card. Drives the real buttons:
// a card that renders but calls nothing is how the goal buttons once shipped dead.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ReviewerPanel } = await import("./reviewer-panel.js");

const h = React.createElement;
const FABLE = "claude-fable-5-1[1m]";

function heldAsk(overrides = {}) {
  return {
    id: "ask-1",
    asker_thread_id: "t1",
    peer_thread_id: "",
    peer_provider: "claude_code",
    peer_model: null,
    title: "Review the retry loop",
    message: "Review the retry loop",
    status: "working",
    delivered: false,
    updated_at: 10,
    model_request: {
      provider: "claude_code",
      model: FABLE,
      family: "Claude Fable",
      decision: "pending",
      options: [
        { model: FABLE, display_name: "Fable", flagship: true, is_default: false },
        { model: "opus[1m]", display_name: "Opus (1M context)", flagship: false, is_default: true },
        { model: "sonnet", display_name: "Sonnet", flagship: false, is_default: false },
      ],
    },
    ...overrides,
  };
}

async function mount(asks, { onDecideModelRequest = async () => {}, onOpenThread = () => {} } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        asks,
        parentThreadId: "t1",
        canRequest: false,
        onDecideModelRequest,
        onOpenThread,
        onDeleteReview() {},
        onResolveReview() {},
      })
    );
  });
  const blocks = () => [...container.querySelectorAll(".reviewer-model-request")];
  const block = (index = 0) => blocks()[index];
  const button = (label, index) =>
    [...(block(index)?.querySelectorAll("button") || [])].find((el) => el.textContent === label);
  return {
    block,
    blocks,
    text: () => container.textContent,
    async click(label, index = 0) {
      const el = button(label, index);
      assert.ok(el, `expected a "${label}" button, got: ${block()?.textContent}`);
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    async choose(model) {
      const select = block().querySelector("select");
      await act(async () => {
        select.value = model;
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a held request says what was asked and that nothing has started", async () => {
  const card = await mount([heldAsk()]);
  const text = card.block()?.textContent || "";
  assert.match(text, /claude-fable-5-1\[1m\]/);
  assert.match(text, /flagship/i);
  assert.match(text, /Nothing has started/);
  // Preselects Sealwire's default, and does not offer the request again as "instead".
  const select = card.block().querySelector("select");
  assert.equal(select.value, "opus[1m]");
  assert.ok(![...select.options].some((option) => option.value === FABLE));
  await card.unmount();
});

test("each of the three answers calls through with what the person chose", async () => {
  for (const [label, prepare, expected] of [
    [`Allow ${FABLE}`, null, ["ask-1", "allow", null]],
    ["Decline", null, ["ask-1", "decline", null]],
    ["Start with this model", "sonnet", ["ask-1", "switch", "sonnet"]],
  ]) {
    const calls = [];
    let opened = 0;
    const card = await mount([heldAsk()], {
      onDecideModelRequest: async (...args) => calls.push(args),
      onOpenThread: () => {
        opened += 1;
      },
    });
    if (prepare) await card.choose(prepare);
    await card.click(label);
    assert.deepEqual(calls, [expected], label);
    assert.equal(opened, 0, "answering must not also open the thread");
    await card.unmount();
  }
});

test("a refused answer is shown beside the buttons", async () => {
  const card = await mount([heldAsk()], {
    onDecideModelRequest: async () => {
      throw new Error("that request has already been decided");
    },
  });
  await card.click("Decline");
  assert.match(card.block().textContent, /already been decided/);
  await card.unmount();
});

test("once decided the card says what started, not what was picked", async () => {
  for (const [label, fields, status, pattern, absent] of [
    [
      "switched to default, started",
      { decision: "switched", chosen_model: "default", started_model: "fake-echo" },
      "working",
      /Started on fake-echo — the agent asked for claude-fable-5-1\[1m\]/,
      /(Ran|Started) on default/,
    ],
    [
      "switched, still starting",
      { decision: "switched", chosen_model: "default" },
      "working",
      /Starting on the default model/,
      /Started on|Ran on/,
    ],
    [
      "switched, start failed",
      { decision: "switched", chosen_model: "opus[1m]", start_error: "fake provider refused" },
      "failed",
      /You picked opus\[1m\], but it did not start: fake provider refused/,
      /Started on|Ran on/,
    ],
    [
      "allowed, started",
      { decision: "allowed", chosen_model: FABLE, started_model: FABLE },
      "working",
      /Started on claude-fable-5-1\[1m\] — you allowed it/,
      null,
    ],
    ["declined", { decision: "declined" }, "cancelled", /You declined claude-fable-5-1\[1m\]/, /Started on/],
  ]) {
    const ask = heldAsk({ status });
    ask.model_request = { ...ask.model_request, ...fields, options: [] };
    const card = await mount([ask]);
    const text = card.block()?.textContent || "";
    assert.match(text, pattern, label);
    if (absent) assert.doesNotMatch(text, absent, label);
    assert.equal(card.block().querySelectorAll("button").length, 0, "nothing left to decide");
    await card.unmount();
  }
});

test("each pending request on the same peer can be decided, including an older one", async () => {
  const older = heldAsk({ peer_thread_id: "peer", title: "Review retries" });
  const newer = heldAsk({ id: "ask-2", peer_thread_id: "peer", title: "Review timeouts", updated_at: 20 });
  const calls = [];
  const card = await mount([older, newer], {
    onDecideModelRequest: async (...args) => calls.push(args),
  });
  assert.equal(card.blocks().length, 2, "both requests have controls");
  await card.click("Decline", 1);
  await card.click(`Allow ${FABLE}`, 0);
  assert.deepEqual(calls, [["ask-1", "decline", null], ["ask-2", "allow", null]]);
  await card.unmount();
});

test("an ordinary follow-up or a decided request cannot hide an older pending request", async () => {
  for (const modelRequest of [null, { decision: "declined", model: FABLE }]) {
    const calls = [];
    const older = heldAsk({ peer_thread_id: "peer", title: "Review retries" });
    const newer = heldAsk({
      id: "ask-2", peer_thread_id: "peer", title: "Review timeouts", updated_at: 20,
      model_request: modelRequest, status: modelRequest ? "cancelled" : "working",
    });
    const card = await mount([older, newer], {
      onDecideModelRequest: async (...args) => calls.push(args),
    });
    const pendingIndex = card.blocks().findIndex((block) => block.querySelector("button"));
    assert.ok(pendingIndex >= 0, "the older request still has controls");
    await card.click("Decline", pendingIndex);
    assert.deepEqual(calls, [["ask-1", "decline", null]]);
    await card.unmount();
  }
});

test("an older approved request shows its start outcome while newer rounds exist", async () => {
  for (const status of ["working", "done"]) {
    const older = heldAsk({ peer_thread_id: "peer", title: "Review retries", status });
    older.model_request = {
      ...older.model_request, decision: "switched", chosen_model: "default", started_model: "fake-echo",
    };
    const newer = heldAsk({
      id: "ask-2", peer_thread_id: "peer", title: "Review timeouts", updated_at: 20,
      model_request: null,
    });
    const card = await mount([older, newer]);
    assert.match(card.text(), /Started on fake-echo/, status);
    assert.doesNotMatch(card.text(), /Started on default|Ran on default/);
    await card.unmount();
  }
});
