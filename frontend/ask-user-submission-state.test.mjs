// Sending an answer has to be visible, and it has to be per-question.
//
// Both surfaces can have several questions parked at once, so "is this one being
// sent" cannot be a single id — with a scalar, sending B re-enables A while A's
// request is still in flight, and A can be sent twice. And on the phone there was
// no submitting/error state at all: a tap with the socket down looked exactly
// like a tap that worked.
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
const { createLocalUiStore } = await import("./local/ui-store.js");
const {
  createInitialRemoteTranscriptUiState,
  reduceRemoteTranscriptUiState,
} = await import("./remote/remote-ui-state.js");

const h = React.createElement;

function request(requestId) {
  return {
    request_id: requestId,
    tool_use_id: `tool-${requestId}`,
    thread_id: "thread-1",
    questions: [
      {
        question: `Question for ${requestId}`,
        header: "Pick",
        multiSelect: false,
        options: [{ label: "A" }],
      },
    ],
  };
}

test("one in-flight answer does not re-enable another", () => {
  const store = createLocalUiStore();
  store.getState().startAskUserSubmission("ask:1");
  store.getState().startAskUserSubmission("ask:2");
  store.getState().finishAskUserSubmission("ask:2");

  const ids = store.getState().askUserSubmittingRequestIds;
  assert.ok(ids.has("ask:1"), "the first answer is still on its way");
  assert.ok(!ids.has("ask:2"), "the second has landed");
});

test("the remote surface tracks sending and failing per question", () => {
  let state = createInitialRemoteTranscriptUiState();
  state = reduceRemoteTranscriptUiState(state, {
    type: "askUser/submitStart",
    requestId: "ask:1",
  });
  assert.ok(
    state.askUserSubmittingRequestIds.has("ask:1"),
    "the phone must be able to say an answer is on its way"
  );

  state = reduceRemoteTranscriptUiState(state, {
    type: "askUser/submitError",
    requestId: "ask:1",
    message: "The relay is offline.",
  });
  assert.equal(
    state.askUserErrors.get("ask:1"),
    "The relay is offline.",
    "and to say when it did not get there"
  );
  assert.ok(
    !state.askUserSubmittingRequestIds.has("ask:1"),
    "a failed send is no longer in flight"
  );

  state = reduceRemoteTranscriptUiState(state, {
    type: "askUser/submitStart",
    requestId: "ask:1",
  });
  assert.equal(
    state.askUserErrors.has("ask:1"),
    false,
    "retrying clears the previous failure rather than stacking it"
  );
});

test("only the question being sent is disabled, and its failure is shown on it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pending = [request("ask:1"), request("ask:2")];
  const entries = pending.map((req) => ({
    item_id: `tool:${req.tool_use_id}`,
    kind: "tool_call",
    status: "running",
    tool: {
      name: "AskUserQuestion",
      input_preview: JSON.stringify({ questions: req.questions }),
    },
  }));

  await act(async () => {
    root.render(
      h(TranscriptContent, {
        entries,
        options: {
          detailEntries: new Map(),
          expandedKeys: new Set(),
          loadingItemIds: new Set(),
          pendingAskUserQuestions: pending,
          onSubmitAskUserAnswers: () => {},
          askUserSubmittingRequestIds: new Set(["ask:1"]),
          askUserErrors: new Map([["ask:2", "The relay is offline."]]),
        },
      })
    );
  });

  const cards = [...container.querySelectorAll(".chat-message-ask-user-interactive")];
  assert.equal(cards.length, 2, "both parked questions are on screen");
  assert.equal(
    cards[0].querySelector(".ask-user-option-button").disabled,
    true,
    "the one being sent cannot be tapped again"
  );
  assert.equal(
    cards[1].querySelector(".ask-user-option-button").disabled,
    false,
    "the other one is still answerable"
  );
  assert.match(
    cards[1].textContent,
    /The relay is offline\./,
    "a failed send says so, on its own card"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("a failure is forgotten once the relay drops the question", () => {
  const store = createLocalUiStore();
  store.getState().setAskUserError("ask:1", "The relay is offline.");
  store.getState().setAskUserError("ask:2", "Also offline.");

  // Answered from another device, or cancelled with the turn: the card is gone,
  // and a stale error would otherwise sit in the map until reload — and greet a
  // reused request id as if the new question had already failed.
  store.getState().retainAskUserErrors(["ask:2"]);

  assert.equal(store.getState().askUserErrors.has("ask:1"), false);
  assert.equal(store.getState().askUserErrors.get("ask:2"), "Also offline.");
});

test("the phone forgets a failure the same way", () => {
  let state = createInitialRemoteTranscriptUiState();
  state = reduceRemoteTranscriptUiState(state, {
    type: "askUser/submitError",
    requestId: "ask:1",
    message: "The relay is offline.",
  });
  state = reduceRemoteTranscriptUiState(state, {
    type: "askUser/retainErrors",
    requestIds: [],
  });

  assert.equal(state.askUserErrors.size, 0, "no question, no failure to report");
});

test("a failure that outlives its question cannot pile up forever", () => {
  // Nothing prunes an error that arrives after the relay already dropped the
  // question (another device answered it while this send was failing).
  const store = createLocalUiStore();
  for (let index = 0; index < 40; index += 1) {
    store.getState().setAskUserError(`ask:${index}`, "The relay is offline.");
  }
  assert.ok(store.getState().askUserErrors.size <= 16, "the map stays bounded");
  assert.ok(
    store.getState().askUserErrors.has("ask:39"),
    "and it is the newest failure that survives, not the oldest"
  );
});
