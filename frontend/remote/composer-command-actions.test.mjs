import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteComposerCommandActions } from "./composer-command-actions.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../shared/goal-objective.js";

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

// Nothing else has logged this one — the helpers that log their own reason are not
// reached — so unlike a helper refusal it must still carry its text back.
test("a status-dump objective is refused before it reaches the relay, with its reason", async () => {
  const setGoal = spy();
  const actions = createRemoteComposerCommandActions({
    setGoal,
    stopGoal: spy(),
    delegate: spy(),
  });
  const dump = "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1);
  const answer = await actions.setGoal("thread-1", dump);
  assert.equal(answer.isError, true);
  assert.ok(answer.text.trim(), "a silent refusal is the bug this whole path exists to avoid");
  assert.match(answer.text, new RegExp(String(MAX_GOAL_OBJECTIVE_CHARS)));
  assert.equal(setGoal.calls.length, 0);
});

// The phone has it worse than the desktop: its log drawer is `display: none` with
// nothing anywhere to open it, so the composer is the ONLY channel there is. And the
// cap is the composer's own judgement — the relay never heard it — so it belongs in
// "not sent", exactly as it does on the desktop. Red would claim something broke.
test("a goal refused for length is held, not reported as a failure", async () => {
  const shown = [];
  const held = [];
  const setGoal = spy();
  const actions = createRemoteComposerCommandActions({
    setGoal,
    stopGoal: spy(),
    delegate: spy(),
    setComposerError: (threadId, message) => shown.push([threadId, message]),
    setComposerHeld: (threadId, message) => held.push([threadId, message]),
  });

  const answer = await actions.setGoal("thread-1", "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));

  assert.equal(answer.isError, true);
  assert.equal(setGoal.calls.length, 0, "refused before the relay");
  assert.deepEqual(
    held.map(([threadId]) => threadId),
    ["thread-1"]
  );
  assert.ok(held[0][1].trim(), "a blank line leaves the refusal nowhere at all");
  assert.deepEqual(
    shown.filter(([, message]) => message.trim()),
    [],
    "and nothing claims something went wrong"
  );
});

// Each region is only cleared by its own writer, so a fixed draft would otherwise send
// under a NOT SENT line still describing the draft it replaced.
test("a fresh goal attempt clears the held slot the last one left", async () => {
  const held = [];
  const actions = createRemoteComposerCommandActions({
    setGoal: spy({ isError: false, text: "" }),
    stopGoal: spy({ isError: false, text: "" }),
    delegate: spy(),
    setComposerHeld: (threadId, message) => held.push([threadId, message]),
  });

  await actions.setGoal("thread-1", "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));
  await actions.setGoal("thread-1", "ship the phone menu");

  assert.deepEqual(held.at(-1), ["thread-1", ""]);
});

test("a refused write comes back as an error so the draft is not cleared", async () => {
  const actions = createRemoteComposerCommandActions({
    setGoal: spy({ isError: true, text: "that thread is busy with a turn" }),
    stopGoal: spy({ isError: true, text: "that thread is busy with a turn" }),
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

// delegate renders its own failure as it happens, so repeating it here would put the
// same sentence on screen twice. The goal helpers are the opposite: they report nowhere.
test("delegate's own reason is not echoed a second time", async () => {
  const actions = createRemoteComposerCommandActions({
    setGoal: spy({ isError: false, text: "" }),
    stopGoal: spy({ isError: false, text: "" }),
    delegate: spy(false),
  });

  assert.equal((await actions.askAgent("t", { message: "look" })).text, "");
});

// The bare boolean was the OLD goal contract. If a helper slips back to it, the refusal
// must become loud, not silent — silence is the whole defect this door exists to close.
test("a goal helper that answers the old boolean is reported, not passed over", async () => {
  const shown = [];
  const actions = createRemoteComposerCommandActions({
    setGoal: spy(false),
    stopGoal: spy(false),
    delegate: spy(),
    setComposerError: (threadId, message) => shown.push([threadId, message]),
  });

  const answer = await actions.setGoal("t", "do it");

  assert.equal(answer.isError, true);
  assert.ok(answer.text.trim(), "a silent refusal is indistinguishable from a dead Send");
  assert.equal(shown.at(-1)[1], answer.text, "and it is on screen, not only returned");
});

// `true` was the old success. Treating it as success would hide the regression instead.
test("a goal helper that answers the old true is reported too", async () => {
  const shown = [];
  const actions = createRemoteComposerCommandActions({
    setGoal: spy(true),
    stopGoal: spy(true),
    delegate: spy(),
    setComposerError: (threadId, message) => shown.push([threadId, message]),
  });

  assert.equal((await actions.setGoal("t", "do it")).isError, true);
  assert.ok(shown.at(-1)[1].trim());
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

// The card door and this one act on the same goal and cannot see each other, so writing
// a goal here has to supersede whatever the card's buttons last reported. Wired but
// never called is indistinguishable from not wired at all.
test("writing a goal from the composer opens a user action on it", async () => {
  const began = [];
  const actions = createRemoteComposerCommandActions({
    setGoal: spy({ isError: false, text: "" }),
    stopGoal: spy({ isError: false, text: "" }),
    delegate: spy(),
    beginGoalAction: (threadId) => began.push(threadId),
  });

  await actions.setGoal("thread-1", "ship the phone menu");
  assert.deepEqual(began, ["thread-1"]);

  await actions.setGoal("thread-1", "   ");
  assert.deepEqual(began, ["thread-1", "thread-1"], "calling it off is a user action too");
});

// Refused before the relay, so nothing about the goal moved and the card's word stands.
test("a refusal that never reaches the relay does not supersede the card", async () => {
  const began = [];
  const actions = createRemoteComposerCommandActions({
    setGoal: spy({ isError: false, text: "" }),
    stopGoal: spy({ isError: false, text: "" }),
    delegate: spy(),
    beginGoalAction: (threadId) => began.push(threadId),
  });

  await actions.setGoal("thread-1", "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));

  assert.deepEqual(began, []);
});
