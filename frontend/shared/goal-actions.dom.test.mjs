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
    extra = {},
    inDialog = false,
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
  const host = inDialog ? document.createElement("dialog") : container;
  if (inDialog) {
    host.appendChild(container);
    document.body.appendChild(host);
    host.setAttribute("open", "");
    host.close = () => host.removeAttribute("open");
  } else {
    document.body.appendChild(container);
  }
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
        ...extra,
      })
    );
  });
  const button = (label) =>
    [...container.querySelectorAll(".reviewer-goal button")].find(
      (el) => el.textContent === label
    );
  return {
    host,
    labels: () => [...container.querySelectorAll(".reviewer-goal button")].map((el) => el.textContent),
    async click(label) {
      const el = button(label);
      assert.ok(el, `expected a "${label}" button on the goal card`);
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

// Cancel must reach the capability that STOPS: remote sends a different action for it, so
// an empty objective routed through `setGoal` would silently do nothing there.
test("Cancel reaches the stop capability, never the write one", async () => {
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
  await panel.click("Cancel");
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

test("Mark done on a completion claim stops the goal; it does not resume it", async () => {
  const stopped = [];
  const written = [];
  const panel = await mountWithGoal(goalCard("complete_claimed"), {
    stopGoal: (threadId) => {
      stopped.push(threadId);
      return Promise.resolve({ text: "" });
    },
    setGoal: (...args) => {
      written.push(args);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Mark done");
  assert.deepEqual(stopped, ["t1"]);
  assert.deepEqual(written, []);
  await panel.unmount();
});

// Each state offers exactly the ways forward the relay can take from it.
test("every settled state has its own buttons", async () => {
  const noop = { onEditGoal() {}, onReplyGoal() {}, onSendGoalOption() {} };
  const labelsFor = async (goal) => {
    const panel = await mountWithGoal(goal, { extra: noop });
    const labels = panel.labels().filter((label) => label !== "×");
    await panel.unmount();
    return labels;
  };
  assert.deepEqual(await labelsFor(goalCard("active")), ["Edit", "Cancel"]);
  assert.deepEqual(await labelsFor(goalCard("complete_claimed")), ["Not done — keep going", "Mark done"]);
  assert.deepEqual(
    await labelsFor({ ...goalCard("awaiting_user"), options: ["Use opus 5.5 high", "Skip it"] }),
    ["Use opus 5.5 high", "Skip it", "Reply…"]
  );
  assert.deepEqual(await labelsFor(goalCard("blocked")), ["Reply…", "Cancel goal"]);
  assert.deepEqual(await labelsFor(goalCard("out_of_turns")), ["Keep going", "Cancel goal"]);
  assert.deepEqual(await labelsFor(goalCard("interrupted")), ["Keep going", "Cancel goal"]);
});

test("Keep going on a goal that ran out of turns resumes the same objective", async () => {
  const calls = [];
  const panel = await mountWithGoal(goalCard("out_of_turns"), {
    setGoal: (threadId, objective) => {
      calls.push([threadId, objective]);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Keep going");
  assert.deepEqual(calls, [["t1", "Ship the mobile surface"]]);
  await panel.unmount();
});

test("an offered answer is sent as it reads, and nothing else is written", async () => {
  const sent = [];
  const written = [];
  const panel = await mountWithGoal(
    { ...goalCard("awaiting_user"), options: ["Use opus 5.5 high"] },
    {
      setGoal: (...args) => written.push(args),
      stopGoal: (...args) => written.push(args),
      extra: { onSendGoalOption: (text) => sent.push(text) },
    }
  );
  await panel.click("Use opus 5.5 high");
  assert.deepEqual(sent, ["Use opus 5.5 high"]);
  assert.deepEqual(written, []);
  await panel.unmount();
});

// On a phone the panel is a modal <dialog>: the composer behind it cannot take focus
// until the dialog is gone.
test("Reply… and Edit leave the panel's dialog for the composer", async () => {
  const replied = [];
  const blocked = await mountWithGoal(goalCard("blocked"), {
    inDialog: true,
    extra: { onReplyGoal: () => replied.push(blocked.host.hasAttribute("open")) },
  });
  await blocked.click("Reply…");
  assert.deepEqual(replied, [false], "the dialog was closed before the composer was asked for");
  await blocked.unmount();

  const edited = [];
  const active = await mountWithGoal(goalCard("active"), {
    inDialog: true,
    extra: { onEditGoal: (objective) => edited.push(objective) },
  });
  await active.click("Edit");
  assert.deepEqual(edited, ["Ship the mobile surface"], "Edit hands over the whole objective");
  assert.equal(active.host.hasAttribute("open"), false);
  await active.unmount();
});

test("the relay's answer is surfaced, and a transport failure does not escape", async () => {
  const lines = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.reject(new Error("socket hang up")),
    log: (line) => lines.push(line),
  });
  await panel.click("Cancel");
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
  await panel.click("Cancel");
  assert.deepEqual(calls, []);
  await panel.unmount();
});

// The card's own buttons are the OTHER door onto the same refusal. The relay answers a
// refusal with 200 + isError, so it is neither a throw nor a success — left to the log
// it reproduces exactly the dead-button symptom this work exists to remove.
test("a refused Cancel is put on screen, not only in the log", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () =>
      Promise.resolve({ text: "that thread is busy with a turn", isError: true }),
    setGoalError: (...args) => shown.push(args),
  });

  await panel.click("Cancel");

  assert.deepEqual(shown.at(-1), ["t1", "that thread is busy with a turn", 1]);
  await panel.unmount();
});

test("a transport failure on the card is shown too", async () => {
  const shown = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.reject(new Error("socket hang up")),
    setGoalError: (threadId, message) => shown.push([threadId, message]),
  });

  await panel.click("Cancel");

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

  await panel.click("Cancel");

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

  await panel.click("Cancel");

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

  await panel.click("Cancel");

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

// A transcript card's button names its own card, and the relay judges it. Its refusal —
// "this card is out of date" — is neither a throw nor a success, so it needs the same
// generation and the same line as the panel's own buttons.
test("a card's button reaches the card capability, and its refusal lands on the goal line", async () => {
  const asked = [];
  const shown = [];
  const opened = [];
  const actions = createGoalActions({
    getThreadId: () => "viewed",
    setGoal: () => asked.push(["set"]),
    stopGoal: () => asked.push(["stop"]),
    goalCard: (threadId, seq, action) => {
      asked.push([threadId, seq, action]);
      return Promise.resolve({
        text: "this card is out of date — the goal has moved on since; act on it from the Agents panel",
        isError: true,
      });
    },
    setGoalError: (...args) => shown.push(args),
    beginGoalAction: (threadId) => {
      opened.push(threadId);
      return 4;
    },
  });

  actions.onGoalCard("t1", 7, "keep_going");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(asked, [["t1", 7, "keep_going"]], "no objective travels, and nothing else is written");
  assert.deepEqual(opened, ["t1"]);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].slice(0, 1), ["t1"]);
  assert.match(shown[0][1], /out of date/);
  assert.equal(shown[0][2], 4, "filed under the action it came from");
});

test("a card's button that cannot reach the relay says so on the goal line", async () => {
  const shown = [];
  const actions = createGoalActions({
    getThreadId: () => "t1",
    goalCard: () => Promise.reject(new Error("socket hang up")),
    setGoalError: (threadId, message) => shown.push([threadId, message]),
    beginGoalAction: () => 1,
  });
  actions.onGoalCard("t1", 2, "stop");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(shown.at(-1)[1], /socket hang up/);
});
