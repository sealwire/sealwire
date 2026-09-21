import test from "node:test";
import assert from "node:assert/strict";

import { createCommandSubmit } from "./composer-command-submit.js";

function harness({ submit } = {}) {
  const state = { pending: {}, scope: "relay-1::thread-a", sent: 0, logs: [] };
  const run = createCommandSubmit({
    getScope: () => state.scope,
    getController: () => ({ submit: submit || (() => null) }),
    isPending: (scope) => Boolean(state.pending[scope]),
    setPending: (scope, value) => {
      state.pending[scope] = value;
    },
    sendMessage: () => {
      state.sent += 1;
    },
    log: (text) => state.logs.push(text),
  });
  return {
    run,
    state,
    get pending() {
      return Boolean(state.pending[state.scope]);
    },
  };
}

test("a draft the menu does not own goes to the agent verbatim", () => {
  // "/undo" is not a command here; swallowing it would silently drop the message.
  const ui = harness({ submit: () => null });

  ui.run();

  assert.equal(ui.state.sent, 1);
  assert.equal(ui.pending, false, "an ordinary send is not a command in flight");
});

test("a command does not also send the draft as a message", () => {
  const ui = harness({ submit: () => Promise.resolve() });

  ui.run();

  assert.equal(ui.state.sent, 0, "the words are the command's arguments, not a turn");
});

test("a second press while a command runs is ignored", async () => {
  let started = 0;
  let release;
  const ui = harness({
    submit: () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  ui.run();
  ui.run();

  assert.equal(started, 1, "pressing Send twice must not delegate twice");
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ui.pending, false, "and the freeze lifts once it lands");
});

test("a command that throws unfreezes the composer and says so", async () => {
  const ui = harness({ submit: () => Promise.reject(new Error("broker is down")) });

  ui.run();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ui.pending, false, "a stuck freeze leaves the composer unusable");
  assert.equal(ui.state.logs.length, 1);
  assert.match(ui.state.logs[0], /broker is down/);
});

test("no controller yet is an ordinary send, not a dropped message", () => {
  const state = { sent: 0 };
  const run = createCommandSubmit({
    getController: () => null,
    isPending: () => false,
    setPending: () => {},
    getScope: () => "relay-1::thread-a",
    sendMessage: () => {
      state.sent += 1;
    },
    log: () => {},
  });

  run();

  assert.equal(state.sent, 1);
});

test("a command still running on one session leaves another usable", async () => {
  // AC3: the freeze belongs to the thread the command was started on. A single boolean
  // meant /delegate on A locked the textarea of every session you opened next.
  let release;
  const ui = harness({
    submit: () => new Promise((resolve) => {
      release = resolve;
    }),
  });

  ui.run();
  assert.equal(ui.pending, true);

  ui.state.scope = "relay-1::thread-b";
  assert.equal(ui.pending, false, "thread B was never sending anything");

  release();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    ui.state.pending["relay-1::thread-a"],
    false,
    "the completion unfreezes the thread it belonged to"
  );
  assert.equal(
    ui.state.pending["relay-1::thread-b"],
    undefined,
    "and never touches the one now on screen"
  );
});

test("a second press on a DIFFERENT session is a send, not a swallowed press", () => {
  // The guard is per scope: A being busy must not make B's Send do nothing.
  const ui = harness({ submit: () => null });
  ui.state.pending["relay-1::thread-a"] = true;
  ui.state.scope = "relay-1::thread-b";

  ui.run();

  assert.equal(ui.state.sent, 1);
});
