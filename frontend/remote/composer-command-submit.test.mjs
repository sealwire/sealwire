import test from "node:test";
import assert from "node:assert/strict";

import { createCommandSubmit } from "./composer-command-submit.js";

function harness({ submit } = {}) {
  const state = { pending: false, sent: 0, logs: [] };
  const run = createCommandSubmit({
    getController: () => ({ submit: submit || (() => null) }),
    isPending: () => state.pending,
    setPending: (value) => {
      state.pending = value;
    },
    sendMessage: () => {
      state.sent += 1;
    },
    log: (text) => state.logs.push(text),
  });
  return { run, state };
}

test("a draft the menu does not own goes to the agent verbatim", () => {
  // "/undo" is not a command here; swallowing it would silently drop the message.
  const { run, state } = harness({ submit: () => null });

  run();

  assert.equal(state.sent, 1);
  assert.equal(state.pending, false, "an ordinary send is not a command in flight");
});

test("a command does not also send the draft as a message", () => {
  const { run, state } = harness({ submit: () => Promise.resolve() });

  run();

  assert.equal(state.sent, 0, "the words are the command's arguments, not a turn");
});

test("a second press while a command runs is ignored", async () => {
  let started = 0;
  let release;
  const { run, state } = harness({
    submit: () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  run();
  run();

  assert.equal(started, 1, "pressing Send twice must not delegate twice");
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.pending, false, "and the freeze lifts once it lands");
});

test("a command that throws unfreezes the composer and says so", async () => {
  const { run, state } = harness({ submit: () => Promise.reject(new Error("broker is down")) });

  run();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(state.pending, false, "a stuck freeze leaves the composer unusable");
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /broker is down/);
});

test("no controller yet is an ordinary send, not a dropped message", () => {
  const state = { sent: 0 };
  const run = createCommandSubmit({
    getController: () => null,
    isPending: () => false,
    setPending: () => {},
    sendMessage: () => {
      state.sent += 1;
    },
    log: () => {},
  });

  run();

  assert.equal(state.sent, 1);
});
