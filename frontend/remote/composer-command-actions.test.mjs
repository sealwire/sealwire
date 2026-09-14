import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteComposerCommandActions } from "./composer-command-actions.js";

function spy(result = true) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return result;
  };
  fn.calls = calls;
  return fn;
}

test("an empty objective calls off the goal instead of setting an empty one", async () => {
  const setGoal = spy();
  const stopGoal = spy();
  const actions = createRemoteComposerCommandActions({
    setGoal,
    stopGoal,
    delegate: spy(),
  });

  await actions.setGoal("thread-1", "   ");

  assert.equal(setGoal.calls.length, 0, "an empty objective is not a goal to set");
  assert.deepEqual(stopGoal.calls, [["thread-1"]]);
});

test("a real objective reaches the relay trimmed", async () => {
  const setGoal = spy();
  const stopGoal = spy();
  const actions = createRemoteComposerCommandActions({
    setGoal,
    stopGoal,
    delegate: spy(),
  });

  await actions.setGoal("thread-1", "  ship the phone menu  ");

  assert.deepEqual(setGoal.calls, [["thread-1", "ship the phone menu"]]);
  assert.equal(stopGoal.calls.length, 0);
});

test("a refused write comes back as an error so the draft is not cleared", async () => {
  const actions = createRemoteComposerCommandActions({
    setGoal: spy(false),
    stopGoal: spy(false),
    delegate: spy(false),
  });

  assert.equal((await actions.setGoal("t", "do it")).isError, true);
  assert.equal((await actions.askAgent("t", { message: "look" })).isError, true);
});

test("delegate forwards every field the command collected", async () => {
  const delegate = spy();
  const actions = createRemoteComposerCommandActions({
    setGoal: spy(),
    stopGoal: spy(),
    delegate,
  });

  await actions.askAgent("thread-1", {
    message: "check the parser",
    agent: "peer-7",
    provider: "codex",
    model: "gpt-5.6",
    effort: "xhigh",
  });

  assert.deepEqual(delegate.calls, [
    [
      "thread-1",
      {
        message: "check the parser",
        agent: "peer-7",
        provider: "codex",
        model: "gpt-5.6",
        effort: "xhigh",
      },
    ],
  ]);
});

test("the relay's own reason is not echoed a second time", async () => {
  // The remote helpers already render their failure, so a non-empty text here
  // would put the same sentence on screen twice.
  const actions = createRemoteComposerCommandActions({
    setGoal: spy(false),
    stopGoal: spy(),
    delegate: spy(false),
  });

  assert.equal((await actions.setGoal("t", "do it")).text, "");
  assert.equal((await actions.askAgent("t", { message: "look" })).text, "");
});

test("a thrown transport failure is an error, not a crash mid-command", async () => {
  const actions = createRemoteComposerCommandActions({
    setGoal: async () => {
      throw new Error("broker is down");
    },
    stopGoal: spy(),
    delegate: async () => {
      throw new Error("broker is down");
    },
  });

  const goal = await actions.setGoal("t", "do it");
  assert.equal(goal.isError, true);
  assert.match(goal.text, /broker is down/);

  const ask = await actions.askAgent("t", { message: "look" });
  assert.equal(ask.isError, true);
  assert.match(ask.text, /broker is down/);
});
