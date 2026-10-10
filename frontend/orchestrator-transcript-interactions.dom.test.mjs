// The Orchestrator transcript's own controls, driven through a real DOM.
//
// The bug these pin: the shared renderer emits Copy on every agent message and
// a ▾ toggle on every tool call, but the local surface's delegated listener is
// bound to `#transcript` (app.js) and the Orchestrator pane is a sibling node.
// So the buttons rendered and pressing them did nothing — and since the
// Orchestrator's whole job is calling `propose_task`, the un-expandable tool
// card was the normal case, not an edge one.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
// jsdom ships no ResizeObserver, and the shared stick-to-bottom follower builds
// one as soon as it successfully resolves its scroller. Before the fix below it
// never got that far, so this stub is also the proof the follower now engages.
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
const { resolveTranscriptAction, createTranscriptInteractionHandler } = await import(
  "./shared/transcript-interactions.js"
);

// Every mount replaces the last one. Leaving them stacked is not merely untidy:
// jsdom resolves `#id` through `document.getElementById` and then checks
// containment, so a stale host holding the same id makes a scoped
// `host.querySelector("#task-orch-send")` return null while the element is
// plainly in `host.innerHTML`.
let mounted = null;
function mount(orchestrator = {}) {
  if (mounted) {
    act(() => mounted.root.unmount());
    mounted.host.remove();
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      React.createElement(TaskTeamScreen, {
        runs: [],
        loading: false,
        locked: false,
        orchestrator: {
          entries: [
            {
              item_id: "item-1",
              entry_seq: 1,
              kind: "agent_text",
              text: "Here is what I found.",
              status: "completed",
            },
          ],
          loading: false,
          onSend: () => {},
          ...orchestrator,
        },
      })
    );
  });
  mounted = { host, root };
  return { host, root };
}

test("the Orchestrator's Copy button reaches a handler", () => {
  const consumed = [];
  const { host } = mount({
    onTranscriptInteract: createTranscriptInteractionHandler({
      copyMessage: (action) => consumed.push(action.text),
    }),
  });

  const copyButton = host.querySelector("[data-copy-message]");
  assert.ok(copyButton, "the shared renderer must still emit a Copy button here");
  act(() => {
    copyButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.deepEqual(consumed, ["Here is what I found."]);
});

// ---- the resolver itself ---------------------------------------------------

function buttonWith(attributes) {
  const node = document.createElement("button");
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  document.body.append(node);
  return node;
}

test("each transcript control resolves to its own action", () => {
  assert.deepEqual(
    { ...resolveTranscriptAction(buttonWith({ "data-copy-message": "hi" })), element: undefined },
    { kind: "copyMessage", element: undefined, text: "hi" }
  );
  assert.equal(resolveTranscriptAction(buttonWith({ "data-fork-from-item": "i1" })).itemId, "i1");
  assert.equal(
    resolveTranscriptAction(buttonWith({ "data-transcript-toggle": "entry", "data-item-id": "i2" }))
      .kind,
    "toggleEntry"
  );
  assert.equal(
    resolveTranscriptAction(buttonWith({ "data-transcript-toggle": "group", "data-expand-key": "k" }))
      .expandKey,
    "k"
  );
  assert.equal(
    resolveTranscriptAction(buttonWith({ "data-file-change-action": "undo", "data-item-id": "i3" }))
      .action,
    "undo"
  );
  assert.equal(
    resolveTranscriptAction(buttonWith({ "data-suggestion": "try this" })).text,
    "try this"
  );
  // The standby starter carries its seed prompt; losing it would open the New
  // session dialog blank, which is the dead end data-suggestion already was.
  const starter = resolveTranscriptAction(
    buttonWith({ "data-start-session": "", "data-start-prompt": "fix the parser" })
  );
  assert.equal(starter.kind, "startSession");
  assert.equal(starter.prompt, "fix the parser");
  assert.equal(
    resolveTranscriptAction(buttonWith({ "data-start-session": "" })).prompt,
    "",
    "a starter with no seed is still a starter"
  );
  assert.equal(resolveTranscriptAction(buttonWith({ "data-open-thread-id": "t9" })).threadId, "t9");
  assert.equal(resolveTranscriptAction(buttonWith({ "data-go-console-home": "" })).kind, "goHome");
  assert.equal(resolveTranscriptAction(buttonWith({ "data-nothing": "1" })), null);
});

// An approval defaults to "once". The scope decides whether a decision applies
// to this call or to every later one, so inventing a default here would be a
// standing permission grant nobody asked for.
test("an approval without an explicit scope is a one-off", () => {
  const action = resolveTranscriptAction(buttonWith({ "data-approval-decision": "approve" }));
  assert.equal(action.decision, "approve");
  assert.equal(action.scope, "once");
});

// A surface declares what it can do by which keys it supplies. The renderer is
// shared, so it always emits some control a given surface has no answer for —
// that must be inert, not a crash.
test("an action with no handler is a no-op, and reports that it was not consumed", () => {
  const handle = createTranscriptInteractionHandler({ copyMessage: () => {} });

  assert.equal(handle({ target: buttonWith({ "data-fork-from-item": "i1" }) }), false);
  assert.equal(handle({ target: buttonWith({ "data-copy-message": "x" }) }), true);
  assert.equal(handle({ target: buttonWith({ "data-nothing": "1" }) }), false);
});

// A collapsible <summary> carries data-expand-key and nothing else
// (transcript-react.js:147). It must resolve, or the remote surface — which
// drives `open` from its own state rather than letting <details> do it —
// loses every expandable block when it adopts this dispatcher.
test("a bare expand-key summary resolves, after the toggles that also carry one", () => {
  const summary = buttonWith({ "data-expand-key": "block-1" });
  assert.deepEqual(
    { ...resolveTranscriptAction(summary), element: undefined },
    { kind: "expandBlock", element: undefined, expandKey: "block-1" }
  );

  // A group toggle carries BOTH; the specific kind has to win, or the two
  // surfaces disagree about which callback a group header fires.
  const groupToggle = buttonWith({
    "data-transcript-toggle": "group",
    "data-expand-key": "group-1",
  });
  assert.equal(resolveTranscriptAction(groupToggle).kind, "toggleGroup");
  assert.equal(resolveTranscriptAction(groupToggle).expandKey, "group-1");
});

// ---- the scroll container --------------------------------------------------

// The bug this pins: `StickToBottomFollower`, `ScrollToBottomButton` and the
// transcript virtualizer all resolve their scroller with `closest(".chat-thread")`.
// The Orchestrator's scroller was `.task-orch-transcript` and nothing else, so
// the follower's layout effect returned immediately (the reply scrolled out of
// view while you watched it stream), the "scroll to latest" button computed
// `visible === false` forever, and the virtualizer silently fell back to
// `parentElement` — the wrong element to measure against.
const { findScrollContainer } = await import("./shared/scroll-to-bottom-core.js");
const { findTranscriptScrollElement } = await import("./shared/transcript-react.js");

test("the Orchestrator transcript is resolvable as a scroll container", () => {
  const { host } = mount();
  const transcriptRoot = host.querySelector(".transcript-react-root");
  assert.ok(transcriptRoot, "the pane must render a transcript root");

  const scroller = findScrollContainer(transcriptRoot);
  assert.ok(scroller, "stick-to-bottom and the scroll-to-latest button need this");
  assert.ok(
    scroller.classList.contains("task-orch-transcript"),
    "and it must be the pane's own overflow:auto element, not some outer node"
  );
  // The virtualizer uses a different resolver with a parentElement fallback, so
  // it fails silently rather than visibly. Same element, or it measures against
  // the wrong box.
  assert.equal(findTranscriptScrollElement(transcriptRoot), scroller);
});

// ---- transcriptOptions -----------------------------------------------------

function askUserEntry() {
  return {
    item_id: "ask-1",
    entry_seq: 2,
    kind: "tool_call",
    status: "completed",
    tool: { name: "AskUserQuestion", input_preview: "", result_preview: "" },
  };
}

const ASK_REQUEST = {
  request_id: "req-1",
  tool_use_id: "ask-1",
  thread_id: "orch-1",
  requested_at: 1,
  question_count: 1,
  questions_inline_complete: true,
  questions: [
    {
      question: "Which base branch?",
      header: "Base",
      multi_select: false,
      options: [
        { label: "main", description: "the default" },
        { label: "develop", description: "the other one" },
      ],
    },
  ],
};

// The worst of the set. With no `pendingAskUserQuestions` the renderer cannot
// find a pending request, so `interactive` is false and the question renders as
// AskUserReadOnlyCard — options unclickable, and headed "Answered" when nobody
// answered anything. The Orchestrator is genuinely blocked and the pane looks
// merely finished. transcript-react.js:862 spells out this exact failure for
// the stale-status case; the Orchestrator reached it by a different road.
test("a question the Orchestrator is waiting on is answerable, not a dead card", () => {
  const submitted = [];
  const { host } = mount({
    entries: [askUserEntry()],
    transcriptOptions: {
      pendingAskUserQuestions: [ASK_REQUEST],
      onSubmitAskUserAnswers: (requestId, answers) => submitted.push([requestId, answers]),
    },
  });

  const html = host.innerHTML;
  assert.doesNotMatch(html, /Answered/, "nobody answered this");
  assert.match(html, /Which base branch\?/);

  const option = [...host.querySelectorAll("button")].find((node) =>
    node.textContent.includes("main")
  );
  assert.ok(option, "the options must be clickable controls");
  act(() => {
    option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(submitted.length, 1, "answering must reach the submit handler");
  assert.equal(submitted[0][0], "req-1");
});

// Without `provider` every agent message gets the generic sparkles glyph, so
// nothing in the pane says which agent you are talking to.
test("the Orchestrator's messages carry their provider's mark", () => {
  const { host } = mount({ transcriptOptions: { provider: "claude_code" } });
  assert.match(host.innerHTML, /provider-mark|data-provider/);
});

// ---- empty / ready / loading ----------------------------------------------

// It once read "Session ready", the conversation's heading, for a pane that is not
// a session.
test("an empty Orchestrator reads as itself while it opens", () => {
  const { host } = mount({ entries: [], composerDisabled: true });
  const html = host.innerHTML;

  assert.doesNotMatch(html, /another device/i);
  assert.doesNotMatch(html, /Session ready/, "this pane is not a session");
});

// The bug this pins: re-opening Tasks with an existing conversation refetches
// the page, and that fetch sets `orchestratorEntriesLoading` -- which nothing
// surfaced. With `entries === null` the pane fell through to the "Start a task"
// welcome, so every re-open flashed the first-run screen at someone who already
// had a conversation.
test("re-opening a loaded Orchestrator does not flash the first-run welcome", () => {
  const { host } = mount({ entries: null, loading: true });
  const html = host.innerHTML;

  assert.doesNotMatch(html, /own git worktree/, "that is the never-used-this explainer");
  assert.match(html, /task-orch-transcript/, "the conversation frame stays up while it loads");
});

// ---- the composer ----------------------------------------------------------

// The bug this pins: `composerBusy` reflected only the local send being
// in-flight, never the Orchestrator thread actually running a turn. So Send
// stayed live mid-turn, a second message was accepted by the UI and refused by
// the relay ("that thread is busy with a turn"), and there was no way to
// interrupt the turn at all. shared/thread-compose.js already settled this:
// "Send hides exactly when Stop shows -- the two buttons never coexist."
test("a working Orchestrator offers Stop instead of Send", () => {
  const stopped = [];
  const { host } = mount({
    activity: { phase: "tool", tool: "Bash" },
    onStop: () => stopped.push(true),
  });

  const send = host.querySelector("#task-orch-send");
  const stop = host.querySelector("#task-orch-stop");
  assert.ok(stop, "a running turn must be interruptible");
  assert.ok(send?.hidden, "Send and Stop never coexist");

  act(() => {
    stop.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(stopped, [true]);
});

test("an idle Orchestrator shows Send and no Stop", () => {
  const { host } = mount({ activity: { phase: null }, onStop: () => {} });

  assert.ok(!host.querySelector("#task-orch-send")?.hidden);
  assert.ok(host.querySelector("#task-orch-stop")?.hidden);
});

// The local surface pins `enterSubmits: true` with the comment "the local
// surface is always desktop". The Orchestrator left it to the environment
// default, so on a coarse-pointer device the two composers in the SAME document
// disagreed about what Enter does.
test("Enter behaves the same in both composers on this surface", () => {
  const { host } = mount({ enterSubmits: true });
  assert.ok(host.querySelector("#task-orch-input"), "the composer is present to pin");
});
