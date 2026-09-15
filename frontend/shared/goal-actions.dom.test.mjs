// Drives the real buttons rather than calling the factory: both were dead for a release
// because the panel rendered them and the handler behind them called a name that existed
// nowhere. (The app.js wiring itself is pinned by undefined-identifier-guard.test.mjs.)
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
const { createGoalActions } = await import("./goal-actions.js");

const h = React.createElement;

function goalCard(status) {
  return {
    objective: "Ship the mobile surface",
    status,
    turns: 3,
    max_turns: 20,
    outcome: status === "active" ? null : "Said it was done.",
  };
}

async function mountWithGoal(
  goal,
  {
    threadId = "t1",
    setGoal = () => {},
    stopGoal = () => {},
    log = () => {},
    setGoalError = () => {},
    beginGoalAction = () => 1,
  } = {}
) {
  const actions = createGoalActions({
    getThreadId: () => threadId,
    setGoal,
    stopGoal,
    log,
    setGoalError,
    beginGoalAction,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        goal,
        onStopGoal: actions.onStopGoal,
        onResumeGoal: actions.onResumeGoal,
        canRequest: false,
        onDeleteReview() {},
        onResolveReview() {},
      })
    );
  });
  const button = (label) =>
    [...container.querySelectorAll(".reviewer-goal .reviewer-card-button")].find(
      (el) => el.textContent === label
    );
  return {
    async click(label) {
      const el = button(label);
      assert.ok(el, `expected a "${label}" button on the goal card`);
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// Stop must reach the capability that STOPS: remote sends a different action for it, so
// an empty objective routed through `setGoal` would silently do nothing there.
test("Stop reaches the stop capability, never the write one", async () => {
  const stopped = [];
  const written = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: (threadId) => {
      stopped.push(threadId);
      return Promise.resolve({ text: "Goal cleared." });
    },
    setGoal: (...args) => {
      written.push(args);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Stop");
  assert.deepEqual(stopped, ["t1"]);
  assert.deepEqual(written, []);
  await panel.unmount();
});

test("a completion claim the user rejects resumes the same objective", async () => {
  const calls = [];
  const panel = await mountWithGoal(goalCard("complete_claimed"), {
    setGoal: (threadId, objective) => {
      calls.push([threadId, objective]);
      return Promise.resolve({ text: "Goal resumed." });
    },
  });
  await panel.click("Not done — keep going");
  assert.deepEqual(calls, [["t1", "Ship the mobile surface"]]);
  await panel.unmount();
});

test("the relay's answer is surfaced, and a transport failure does not escape", async () => {
  const lines = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.reject(new Error("socket hang up")),
    log: (line) => lines.push(line),
  });
  await panel.click("Stop");
  assert.match(lines.join("\n"), /socket hang up/);
  await panel.unmount();
});

test("with no thread in view the buttons write nothing", async () => {
  const calls = [];
  const panel = await mountWithGoal(goalCard("active"), {
    threadId: null,
    stopGoal: (...args) => {
      calls.push(args);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Stop");
  assert.deepEqual(calls, []);
  await panel.unmount();
});

// The card's own buttons are the OTHER door onto the same refusal. The relay answers a
// refusal with 200 + isError, so it is neither a throw nor a success — left to the log
// it reproduces exactly the dead-button symptom this work exists to remove.
test("a refused Stop is put on screen, not only in the log", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () =>
      Promise.resolve({ text: "that thread is busy with a turn", isError: true }),
    setGoalError: (...args) => shown.push(args),
  });

  await panel.click("Stop");

  assert.deepEqual(shown.at(-1), ["t1", "that thread is busy with a turn", 1]);
  await panel.unmount();
});

test("a transport failure on the card is shown too", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.reject(new Error("socket hang up")),
    setGoalError: (threadId, message) => shown.push([threadId, message]),
  });

  await panel.click("Stop");

  assert.match(shown.at(-1)[1], /socket hang up/);
  await panel.unmount();
});

// Opening the action is what clears the last one's word — and it happens BEFORE the
// capability is awaited, so a success settling late cannot erase a newer failure.
test("each press opens a new action, and a success writes nothing afterwards", async () => {
  const shown = [];
  const opened = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.resolve({ text: "Goal cleared.", isError: false }),
    setGoalError: (threadId, message) => shown.push([threadId, message]),
    beginGoalAction: (threadId) => {
      opened.push(threadId);
      return opened.length;
    },
  });

  await panel.click("Stop");

  assert.deepEqual(opened, ["t1"], "the attempt opens an action");
  assert.deepEqual(shown, [], "and a success has nothing of its own to say");
  await panel.unmount();
});

// A bare boolean was the OLD contract, back when the helpers reported themselves. If one
// slips back to it, this card has nowhere else to learn the refusal from — so it must
// become loud rather than leaving the button looking dead again.
test("a capability that answers the old boolean is reported, not passed over", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.resolve(false),
    setGoalError: (threadId, message) => shown.push([threadId, message]),
  });

  await panel.click("Stop");

  assert.ok(shown.at(-1)[1].trim(), "the contract breach is said out loud");
  await panel.unmount();
});

// A handler nobody wired answers `undefined` through the optional chain, which is the
// silent-no-op this whole channel exists to make impossible.
test("a capability nobody wired is reported rather than looking like success", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: undefined,
    setGoalError: (threadId, message) => shown.push([threadId, message]),
  });

  await panel.click("Stop");

  assert.ok(shown.at(-1)[1].trim());
  await panel.unmount();
});

// A Stop that partly succeeds cancels the goal — and a cancelled goal is left out of the
// snapshot, so the card it was pressed on is gone. The warning it returned outlives it
// with no button to supersede it: the user can do what it says, succeed, and still read
// "the turn it started is still running" forever. It needs a way to end.
test("the warning left behind by a vanished goal can be dismissed", async () => {
  const dismissed = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        goal: null,
        goalError: "the goal is stopped, but the turn it started is still running",
        onDismissGoalError: () => dismissed.push(true),
        reviewJobs: [],
        canRequest: false,
      })
    );
  });

  const dismiss = container.querySelector(".reviewer-goal-error-dismiss");
  assert.ok(dismiss, "a message nothing can clear needs its own way out");

  await act(async () => {
    dismiss.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(dismissed, [true]);

  await act(async () => root.unmount());
  container.remove();
});
