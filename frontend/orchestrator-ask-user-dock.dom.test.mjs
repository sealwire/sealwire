// The Orchestrator conversation answers questions the same way every other
// conversation does: the live card sits above its composer, outside the pane's
// own scroller, and the transcript keeps only the record of the ask. Left in the
// transcript it can be scrolled away from and is rebuilt with the list — the
// lifecycle this change removes everywhere else.
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
dom.window.ResizeObserver = class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.ResizeObserver = dom.window.ResizeObserver;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TaskTeamScreen } = await import("./shared/task-team-react.js");

const h = React.createElement;

const ORCH_THREAD = "orch-thread-1";
const TOOL_USE_ID = "askuser-orch";

function questions() {
  return [
    {
      question: "Which team shape?",
      header: "Shape",
      multiSelect: false,
      options: [{ label: "One dev" }, { label: "Two devs" }],
    },
  ];
}

function pending() {
  return [
    {
      request_id: "ask:orch-1",
      tool_use_id: TOOL_USE_ID,
      thread_id: ORCH_THREAD,
      questions: questions(),
    },
  ];
}

function mount(extraOptions = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      h(TaskTeamScreen, {
        runs: [],
        loading: false,
        locked: false,
        orchestrator: {
          entries: [
            {
              item_id: `tool:${TOOL_USE_ID}`,
              entry_seq: 1,
              kind: "tool_call",
              status: "running",
              tool: {
                name: "AskUserQuestion",
                input_preview: JSON.stringify({ questions: questions() }),
              },
            },
            {
              item_id: "item-after",
              entry_seq: 2,
              kind: "agent_text",
              text: "Meanwhile, here is some context.",
              status: "completed",
            },
          ],
          loading: false,
          onSend: () => {},
          askUserThreadId: ORCH_THREAD,
          transcriptOptions: {
            expandedKeys: new Set(),
            loadingItemIds: new Set(),
            pendingAskUserQuestions: pending(),
            onSubmitAskUserAnswers: () => {},
            askUserSubmittingRequestIds: new Set(),
            askUserErrors: new Map(),
            askUserDocked: true,
            ...extraOptions,
          },
        },
      })
    );
  });
  return { host, root };
}

test("the Orchestrator's live question is docked above its composer", () => {
  const { host, root } = mount();

  const scroller = host.querySelector(".task-orch-transcript");
  const live = host.querySelector(".chat-message-ask-user-interactive");
  assert.ok(scroller, "precondition: the pane has its own scroller");
  assert.ok(live, "the question the Orchestrator is parked on must be answerable");
  assert.equal(
    scroller.contains(live),
    false,
    "inside the pane's scroller the card can be scrolled away from and rebuilt with the list"
  );
  assert.equal(
    scroller.querySelectorAll(".ask-user-option-button").length,
    0,
    "and the record left in the conversation must not show options that do nothing"
  );
  assert.match(
    scroller.textContent,
    /Waiting for your answer/,
    "the record still says the question is open"
  );

  const composer = host.querySelector(".task-orch-composer, #task-orch-send");
  assert.ok(composer, "precondition: the pane has a composer");
  assert.ok(
    live.compareDocumentPosition(composer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the card belongs above the box you would otherwise type into"
  );

  act(() => root.unmount());
  host.remove();
});

test("the Orchestrator pane answers only its own thread's questions", () => {
  // The pane is handed the whole pending list in some states — notably before an
  // Orchestrator thread exists, when the thread-filter helper falls back to the
  // ACTIVE session. Docking that above the Orchestrator's composer puts the
  // running session's question on a conversation it does not belong to, and
  // answering it resumes a session the reader cannot see here.
  const { host, root } = mount({
    pendingAskUserQuestions: [
      {
        request_id: "ask:session",
        tool_use_id: "askuser-session",
        thread_id: "some-other-session",
        questions: questions(),
      },
    ],
  });

  assert.equal(
    host.querySelectorAll(".ask-user-dock .chat-message-ask-user-interactive").length,
    0,
    "another conversation's question must not be answerable from the Tasks pane"
  );

  act(() => root.unmount());
  host.remove();
});
