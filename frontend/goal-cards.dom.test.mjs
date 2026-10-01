// The goal card's buttons carry what a surface needs to act, as drawn, and every surface
// that shows a transcript answers them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");
const { createTranscriptInteractionHandler, resolveTranscriptAction } = await import(
  "./shared/transcript-interactions.js"
);
const { focusComposer, prefillComposer } = await import("./shared/composer-prefill.js");

const h = React.createElement;
const settleRow = (card) => ({
  item_id: "settle",
  kind: "tool_call",
  status: "completed",
  text: "",
  tool: { item_type: "mcpToolCall", name: "goal_needs_you", title: "goal_needs_you", input_preview: "{}" },
  injection: {
    kind: "goal_settled",
    goal_settled: {
      goal_id: "goal-1",
      thread_id: "t1",
      seq: 7,
      status: "awaiting_user",
      objective: "Ship it",
      turns: 3,
      max_turns: 20,
      provider: "claude_code",
      steps: [],
      left_for_you: [],
      report: "Which model?",
      options: ["Use opus 5.5 high"],
      settled_at: 1,
      resolution: null,
      ...card,
    },
  },
});

async function mount(entries) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));
  return {
    container,
    button: (text) => [...container.querySelectorAll("button")].find((el) => el.textContent === text),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("an offered answer names its thread, its goal, its card and its text", async () => {
  const { button, unmount } = await mount([settleRow()]);
  const option = resolveTranscriptAction(button("Use opus 5.5 high"));
  assert.equal(option.kind, "goalAction");
  assert.equal(option.action, "option");
  assert.equal(option.threadId, "t1");
  assert.equal(option.goalId, "goal-1");
  assert.equal(option.seq, "7", "and which card, since a revised goal keeps its id");
  assert.equal(option.option, "Use opus 5.5 high");
  assert.equal(resolveTranscriptAction(button("Reply…")).action, "reply");
  await unmount();
});

test("a claim's buttons resume and stop, and its report opens in place", async () => {
  const { container, button, unmount } = await mount([
    settleRow({ status: "complete_claimed", options: [], report: "All **tests** pass." }),
  ]);
  const handled = [];
  const handle = createTranscriptInteractionHandler({ goalAction: (action) => handled.push(action.action) });
  handle({ target: button("Not done — keep going") });
  handle({ target: button("Mark done") });
  assert.deepEqual(handled, ["resume", "stop"]);

  assert.equal(container.querySelector(".goal-card-report"), null);
  await act(async () => {
    button("Full report").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.match(container.querySelector(".goal-card-report").innerHTML, /<strong>tests<\/strong>/);
  assert.equal(button("Full report").getAttribute("aria-expanded"), "true");
  await unmount();
});

test("Edit puts the goal command in the box as if typed, where a controller can see it", () => {
  const input = document.createElement("textarea");
  document.body.appendChild(input);
  const typed = [];
  input.addEventListener("input", () => typed.push(input.value));
  assert.equal(prefillComposer(input, "/goal ship it"), true);
  assert.deepEqual(typed, ["/goal ship it"]);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, "/goal ship it".length, "the caret waits after the text");

  input.disabled = true;
  assert.equal(prefillComposer(input, "/goal other"), false, "a locked box is left alone");
  assert.equal(focusComposer(input), false);
  input.remove();
});

// Both shells only evaluate in a browser, so this is the structural half: the resolver
// is shared, and a surface that leaves `goalAction` out renders buttons that do nothing.
// Keep going and stop must reach the relay's card check, never a write built from this
// device's copy of the goal, which can be stale.
test("both surfaces answer the goal card's buttons through the relay's card check", () => {
  const goalHandler = (source, head) => {
    const start = source.indexOf(head);
    assert.notEqual(start, -1, `${head} is gone`);
    return source.slice(start, source.indexOf("}),", start));
  };

  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const local = goalHandler(app, "goalAction: (action) =>");
  assert.match(local, /void dispatchGoalAction\(action, \{/);
  assert.match(local, /card: reviewerActions\.onGoalCard/, "the desktop's buttons go to the card check");
  assert.doesNotMatch(local, /goalForThread|onResumeGoal|onStopGoal/, "and never through its cached goal");
  assert.match(
    app,
    /goalCard: \(threadId, seq, action\) =>\s*postRelayCommand\("\/api\/session\/goal\/card", \{ thread_id: threadId, seq, action \}\)/,
    "the desktop's card capability is the loopback card route"
  );

  const panel = readFileSync(new URL("./remote/remote-transcript-panel.js", import.meta.url), "utf8");
  assert.match(panel, /goalAction: \(action, event\) => \{[\s\S]{0,80}?onGoalAction\?\.\(action\)/);
  const remote = readFileSync(new URL("./remote/react-app.js", import.meta.url), "utf8");
  const phone = goalHandler(remote, "onGoalAction: (action) =>");
  assert.match(phone, /void dispatchGoalAction\(action, \{/);
  assert.match(phone, /card: reviewerActions\.onGoalCard/, "the phone's buttons go to the card check");
  assert.doesNotMatch(phone, /goalForThread|remoteReviews|onResumeGoal|onStopGoal/);
  assert.match(
    remote,
    /goalCard: \(threadId, seq, action\) =>\s*handlersRef\.current\.onGoalCard\?\.\(threadId, seq, action\)/,
    "the phone's card capability is the runtime's goal_card action"
  );
  assert.match(remote, /h\(RemoteTranscriptPanel, \{[\s\S]{0,400}?onGoalAction,/, "and hands it to the transcript");
  for (const [name, source] of [["app.js", app], ["react-app.js", remote]]) {
    for (const key of ["onEditGoal", "onReplyGoal", "onSendGoalOption"]) {
      assert.match(source, new RegExp(`${key}: \\(`), `${name} wires the Agents card's ${key}`);
    }
  }
});
