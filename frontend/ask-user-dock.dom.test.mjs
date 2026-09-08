// An unanswered question is live UI, not history.
//
// As a transcript row it inherits the transcript's lifetime: it is moved to the
// bottom while pending, rebuilt whenever the snapshot blinks, and unmounted when
// virtualization scrolls it away — each of which takes a half-finished answer
// with it. Docked, it is mounted for as long as the question is pending and the
// transcript keeps only the record that it was asked.
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
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");
const { AskUserDock } = await import("./shared/ask-user-dock.js");

const h = React.createElement;

const TOOL_USE_ID = "askuser-1";
const ITEM_ID = `tool:${TOOL_USE_ID}`;
const REQUEST_ID = "req-ask-1";
const TRAILING_TEXT = "Meanwhile, here is some context.";

function questions() {
  return [
    {
      question: "Which approach?",
      header: "Approach",
      multiSelect: false,
      options: [{ label: "Option A" }, { label: "Option B" }],
    },
    {
      question: "Which surface?",
      header: "Surface",
      multiSelect: false,
      options: [{ label: "Local" }, { label: "Remote" }],
    },
  ];
}

function pendingList() {
  return JSON.parse(
    JSON.stringify([
      {
        request_id: REQUEST_ID,
        tool_use_id: TOOL_USE_ID,
        thread_id: "thread-1",
        questions: questions(),
      },
    ])
  );
}

// The question's tool call is NOT the last entry: something followed it, which is
// what the old pin existed to work around.
function entries(tail = TRAILING_TEXT) {
  return [
    { item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" },
    {
      item_id: ITEM_ID,
      kind: "tool_call",
      status: "running",
      tool: {
        name: "AskUserQuestion",
        input_preview: JSON.stringify({ questions: questions() }),
      },
    },
    { item_id: "msg-2", kind: "agent_text", text: tail, status: "completed" },
  ];
}

function options(pending, extra = {}) {
  return {
    detailEntries: new Map(),
    expandedKeys: new Set(),
    loadingItemIds: new Set(),
    pendingAskUserQuestions: pending,
    onSubmitAskUserAnswers: () => {},
    askUserSubmittingRequestIds: new Set(),
    askUserErrors: new Map(),
    ...extra,
  };
}

test("a docked transcript keeps the record in place and no live card of its own", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(TranscriptContent, {
        entries: entries(),
        options: options(pendingList(), { askUserDocked: true }),
      })
    );
  });

  assert.equal(
    container.querySelectorAll(".chat-message-ask-user-interactive").length,
    0,
    "the transcript must not render a second live copy of the question"
  );
  assert.equal(
    container.querySelectorAll(".ask-user-option-button").length,
    0,
    "nor options that look clickable but are not"
  );

  const rows = [...container.querySelectorAll(".chat-message")];
  const askIndex = rows.findIndex((row) => row.className.includes("chat-message-ask-user"));
  const trailingIndex = rows.findIndex((row) => (row.textContent || "").includes(TRAILING_TEXT));
  assert.ok(askIndex >= 0 && trailingIndex >= 0, "both rows must be rendered");
  assert.ok(
    askIndex < trailingIndex,
    "the record stays where the question was actually asked, above what followed it"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("the docked card outlives the transcript re-rendering underneath it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const paint = async (tail) => {
    await act(async () => {
      root.render(
        h(
          React.Fragment,
          null,
          h(TranscriptContent, {
            entries: entries(tail),
            options: options(pendingList(), { askUserDocked: true }),
          }),
          h(AskUserDock, {
            pendingAskUserQuestions: pendingList(),
            options: options(pendingList(), { askUserDocked: true }),
          })
        )
      );
    });
  };

  await paint(TRAILING_TEXT);
  const dockCard = () => container.querySelector(".ask-user-dock .chat-message-ask-user-interactive");
  const optionButtons = () => [...container.querySelectorAll(".ask-user-dock .ask-user-option-button")];
  assert.ok(dockCard(), "the dock renders the question the turn is parked on");

  await act(async () => {
    optionButtons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(optionButtons()[0].getAttribute("aria-pressed"), "true");
  const cardNode = dockCard();

  // The turn keeps writing to the transcript while the reader is answering.
  await paint("Something else arrived while you were choosing.");

  assert.equal(dockCard(), cardNode, "the dock card must not be rebuilt by transcript churn");
  assert.equal(
    optionButtons()[0].getAttribute("aria-pressed"),
    "true",
    "and the pick must still be there"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("the dock answers only for the thread on screen", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const otherThread = {
    request_id: "req-other",
    tool_use_id: "askuser-other",
    thread_id: "thread-2",
    questions: [
      {
        question: "A background task is asking something",
        header: "Other",
        multiSelect: false,
        options: [{ label: "Nope" }],
      },
    ],
  };

  await act(async () => {
    root.render(
      h(AskUserDock, {
        pendingAskUserQuestions: [...pendingList(), otherThread],
        threadId: "thread-1",
        options: options(pendingList(), { askUserDocked: true }),
      })
    );
  });

  // Snapshots carry every thread's pending questions. Docking one from a
  // background thread puts an answer box with no conversation behind it above
  // the composer — and answering it resumes a turn the reader cannot see.
  assert.equal(
    container.querySelectorAll(".chat-message-ask-user-interactive").length,
    1,
    "only the viewed thread's question may be docked"
  );
  assert.doesNotMatch(
    container.textContent,
    /A background task is asking something/,
    "another thread's question must not be answerable here"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("two picks made in one batch both stick", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const multi = [
    {
      request_id: "req-multi",
      tool_use_id: "askuser-multi",
      thread_id: "thread-1",
      questions: [
        {
          question: "Which ones?",
          header: "Pick",
          multiSelect: true,
          options: [{ label: "One" }, { label: "Two" }],
        },
      ],
    },
  ];
  await act(async () => {
    root.render(
      h(AskUserDock, {
        pendingAskUserQuestions: multi,
        threadId: "thread-1",
        options: options(multi, { askUserDocked: true }),
      })
    );
  });

  const buttons = () => [...container.querySelectorAll(".ask-user-option-button")];
  // Coalesced into one batch: reading the render's state instead of the latest
  // makes the second pick overwrite the first, in React AND in the draft.
  await act(async () => {
    buttons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    buttons()[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(
    buttons().map((button) => button.getAttribute("aria-pressed")),
    ["true", "true"],
    "a multi-select must keep both picks"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("a card is not reused across threads that share a request id", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Same wording, different options — the shape that actually carries state
  // across: picks are held per question TEXT, so identical text plus a reused
  // request id lets one conversation's answer ride into another.
  const request = (threadId, labels) => [
    {
      request_id: "ask:1",
      tool_use_id: "askuser-1",
      thread_id: threadId,
      questions: [
        {
          question: "Which approach?",
          header: "Pick",
          multiSelect: false,
          options: labels.map((label) => ({ label })),
        },
        { question: "And?", header: "Then", multiSelect: false, options: [{ label: "C" }] },
      ],
    },
  ];
  const paint = async (threadId, labels) => {
    await act(async () => {
      root.render(
        h(AskUserDock, {
          pendingAskUserQuestions: request(threadId, labels),
          threadId,
          options: options(request(threadId, labels), { askUserDocked: true }),
        })
      );
    });
  };

  await paint("thread-a", ["A", "B"]);
  const buttons = () => [...container.querySelectorAll(".ask-user-option-button")];
  await act(async () => {
    buttons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");

  // Request ids are numbered per provider session, so a second relay or session
  // reuses "ask:1" for something else entirely. Keyed on the id alone, React
  // keeps the old card mounted and the reader's pick rides along invisibly:
  // nothing shows as chosen, but Continue is live and submits the old answer.
  await paint("thread-b", ["X", "Y"]);

  assert.deepEqual(
    buttons().map((button) => button.getAttribute("aria-pressed")),
    ["false", "false"],
    "a different thread's question starts unanswered"
  );
  assert.equal(
    container.querySelector(".ask-user-wizard-next")?.disabled,
    true,
    "and cannot be advanced on an answer that belongs to another conversation"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("two questions asking the same thing get their own notes box", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const sameText = (requestId, threadId) => ({
    request_id: requestId,
    tool_use_id: `tool-${requestId}`,
    thread_id: threadId,
    questions: [
      {
        question: "Which approach?",
        header: "Approach",
        multiSelect: false,
        options: [{ label: "A" }],
      },
    ],
  });
  const pending = [sameText("ask:1", "thread-1"), sameText("ask:2", "thread-1")];

  await act(async () => {
    root.render(
      h(AskUserDock, {
        pendingAskUserQuestions: pending,
        threadId: "thread-1",
        options: options(pending, { askUserDocked: true }),
      })
    );
  });

  // A turn can issue several AskUserQuestion calls, and two of them can word the
  // question identically. Ids derived from the text alone collide, and then the
  // second card's label focuses the first card's textarea.
  const ids = [...container.querySelectorAll(".ask-user-notes-input")].map((node) => node.id);
  assert.equal(ids.length, 2, "both questions render a notes box");
  assert.notEqual(ids[0], ids[1], "each notes box needs its own id for its own label");

  await act(async () => root.unmount());
  container.remove();
});

test("a question whose detail is still loading is announced once, not twice", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Externalized by the remote budget: the row carries no questions and the
  // transcript preview cannot be parsed either, so both the transcript entry and
  // the dock have something to say about it.
  const externalized = [
    {
      request_id: "ask:big",
      tool_use_id: TOOL_USE_ID,
      thread_id: "thread-1",
      question_count: 2,
      questions_inline_complete: false,
      detail_available: true,
      questions: [],
    },
  ];
  const entriesWithoutPreview = [
    {
      item_id: ITEM_ID,
      kind: "tool_call",
      status: "running",
      tool: { name: "AskUserQuestion", input_preview: "{ truncated" },
    },
  ];

  await act(async () => {
    root.render(
      h(
        React.Fragment,
        null,
        h(TranscriptContent, {
          entries: entriesWithoutPreview,
          options: options(externalized, { askUserDocked: true }),
        }),
        h(AskUserDock, {
          pendingAskUserQuestions: externalized,
          threadId: "thread-1",
          options: options(externalized, { askUserDocked: true }),
        })
      )
    );
  });

  const loadingCards = [...container.querySelectorAll(".chat-message-ask-user")].filter((node) =>
    /loading/i.test(node.textContent || "")
  );
  assert.equal(
    loadingCards.length,
    1,
    "one waiting question, one card saying so — two live regions announce it twice"
  );

  await act(async () => root.unmount());
  container.remove();
});
