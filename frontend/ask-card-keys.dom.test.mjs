// A one-question card sends on a single pick, so any key that picks must be
// one the reader aimed at an option — never a stray digit or an IME keystroke.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.MouseEvent = dom.window.MouseEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent, TranscriptEntry } = await import("./shared/transcript-react.js");
const { resetAskUserDraftsForTest } = await import("./shared/ask-user-draft-store.js");

const h = React.createElement;

function questions(count) {
  return [
    { question: "Which approach?", header: "Approach", multiSelect: false, options: [{ label: "Option A" }, { label: "Option B" }] },
    { question: "Which surface?", header: "Surface", multiSelect: false, options: [{ label: "Local" }, { label: "Remote" }] },
  ].slice(0, count);
}

async function mountCard(count, submitted) {
  resetAskUserDraftsForTest();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const qs = questions(count);
  const entry = {
    item_id: "tool:ask-keys",
    kind: "tool_call",
    status: "running",
    tool: { name: "AskUserQuestion", input_preview: JSON.stringify({ questions: qs }) },
  };
  await act(async () => {
    root.render(
      h(TranscriptContent, {
        entries: [entry],
        options: {
          pendingAskUserQuestions: [
            { request_id: "req-keys", transcript_row_id: entry.item_id, thread_id: "t", questions: qs },
          ],
          onSubmitAskUserAnswers: (requestId, answers) => submitted.push(answers),
          askUserSubmittingRequestIds: new Set(),
          askUserErrors: new Map(),
        },
      })
    );
  });
  return { container, root };
}

async function press(target, key, { keyCode, ...init } = {}) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  // jsdom drops the legacy keyCode from the init dict.
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  await act(async () => {
    target.dispatchEvent(event);
  });
}

const optionButtons = (container) => [...container.querySelectorAll(".ask-user-option-button")];

test("a digit typed while another button in the card has focus sends nothing", async () => {
  const submitted = [];
  const { container, root } = await mountCard(1, submitted);
  await press(container.querySelector(".ask-user-decide"), "1");
  assert.deepEqual(submitted, []);
  await act(async () => root.unmount());
});

test("a digit that is part of an IME composition sends nothing", async () => {
  const submitted = [];
  const { container, root } = await mountCard(1, submitted);
  await press(optionButtons(container)[0], "1", { isComposing: true });
  await press(optionButtons(container)[0], "1", { keyCode: 229 });
  assert.deepEqual(submitted, []);
  await act(async () => root.unmount());
});

test("a held-down digit picks once, not on every repeat", async () => {
  const submitted = [];
  const { container, root } = await mountCard(1, submitted);
  await press(optionButtons(container)[0], "2", { repeat: true });
  assert.deepEqual(submitted, []);
  await act(async () => root.unmount());
});

test("a digit on a focused option picks that number", async () => {
  const submitted = [];
  const { container, root } = await mountCard(1, submitted);
  await press(optionButtons(container)[0], "2");
  assert.deepEqual(submitted, [{ "Which approach?": "Option B" }]);
  await act(async () => root.unmount());
});

// "Something else" is drawn as one more radio row, so it has to behave like one.
test("typing something else unpicks the option, and picking an option sends only that option", async () => {
  const submitted = [];
  const { container, root } = await mountCard(2, submitted);
  const notes = () => container.querySelector(".ask-user-notes-input");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  const type = async (value) => {
    await act(async () => {
      setter.call(notes(), value);
      notes().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };

  await click(optionButtons(container)[0]);
  assert.equal(optionButtons(container)[0].getAttribute("aria-checked"), "true");
  await type("Neither — use C");
  assert.equal(optionButtons(container)[0].getAttribute("aria-checked"), "false", "typing moves the pick to Something else");

  await click(optionButtons(container)[1]);
  assert.equal(optionButtons(container)[1].getAttribute("aria-checked"), "true");
  await click(container.querySelector(".ask-user-wizard-next"));
  await click(optionButtons(container)[0]);
  await click(container.querySelector(".ask-user-submit-button"));
  assert.deepEqual(submitted, [{ "Which approach?": "Option B", "Which surface?": "Local" }]);
  await act(async () => root.unmount());
});

// Showing the real last lines is not worth fetching every failed output unasked;
// the full body is fetched only when the reader opens it.
test("a failed row cut short does not fetch its full output on its own", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const asked = [];
  const entry = {
    item_id: "tool:bash-cut",
    kind: "tool_call",
    status: "failed",
    content_state: "preview",
    tool: { item_type: "toolCall", name: "Bash", command: "npm test", result_preview: "Exit code 1\nhead..." },
  };
  const opts = { onEnsureFileChangeDetail: (itemId) => asked.push(itemId) };
  await act(async () => root.render(h(TranscriptEntry, { entry, options: opts })));
  assert.deepEqual(asked, []);
  await act(async () => root.unmount());
});

// The typed text stays visible after picking an option, so it has to look unpicked,
// and going back to it has to pick it again — never two rows that both look chosen.
test("picking an option unpicks the typed answer; returning to the text picks it back", async () => {
  const submitted = [];
  const { container, root } = await mountCard(2, submitted);
  const notes = () => container.querySelector(".ask-user-notes-input");
  const other = () => container.querySelector(".ask-user-other");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setter.call(notes(), "Neither — use C");
    notes().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(other().classList.contains("is-chosen"));

  await act(async () => {
    optionButtons(container)[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(other().classList.contains("is-chosen"), false, "the option took the pick");

  await act(async () => {
    notes().dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    notes().dispatchEvent(new dom.window.FocusEvent("focus"));
  });
  assert.equal(optionButtons(container)[1].getAttribute("aria-checked"), "false");
  assert.ok(other().classList.contains("is-chosen"));
  await act(async () => root.unmount());
});
