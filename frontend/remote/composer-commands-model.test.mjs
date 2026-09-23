import test from "node:test";
import assert from "node:assert/strict";

import { CONTROLLER_CAPABILITIES } from "./composer-command-host.js";
import { createComposerCommandsModel } from "./composer-commands-model.js";

function model(overrides = {}) {
  return createComposerCommandsModel({
    getCatalog: () => ({}),
    getContext: () => ({}),
    requestReview: async () => {},
    hold: () => {},
    log: () => {},
    actions: {
      setGoal: async () => ({}),
      askAgent: async () => ({}),
      handOver: async () => ({}),
    },
    ...overrides,
  });
}

test("the model answers every capability the host forwards", () => {
  // The host wraps each of these unconditionally. One left out is not a missing
  // menu entry — the command runs, the relay does the work, and the controller
  // then throws on the way back, with the pills still staged and nothing said.
  const built = model();

  for (const capability of CONTROLLER_CAPABILITIES) {
    assert.equal(
      typeof built[capability],
      "function",
      `the controller calls ${capability}; a model without it fails after the write has landed`
    );
  }
});

test("the capability list is the host's, not a second copy that can drift", () => {
  assert.ok(CONTROLLER_CAPABILITIES.includes("log"));
  assert.ok(CONTROLLER_CAPABILITIES.includes("askAgent"));
  assert.ok(CONTROLLER_CAPABILITIES.includes("handOver"));
  assert.ok(CONTROLLER_CAPABILITIES.includes("setGoal"));
  assert.ok(CONTROLLER_CAPABILITIES.includes("hold"));
});

test("nothing is logged for a helper that already spoke for itself", () => {
  // The remote helpers render their own progress and failure, so the adapter hands
  // back empty text; forwarding it would append a timestamp-only row and re-render.
  const lines = [];
  const built = model({ log: (text) => lines.push(text) });

  built.log("");
  built.log("Open a session first.");

  assert.deepEqual(lines, ["Open a session first."]);
});

// `/goal` is protected because its action clears the error line explicitly; `/delegate`
// and `/review` refuse LOCALLY and never reach an action, so a red line from an earlier
// attempt used to stay on screen underneath the new NOT SENT one — two diagnoses at once,
// the older one no longer true.
test("a refusal the composer wrote itself retires the last attempt's error line", () => {
  const held = [];
  const cleared = [];
  const command = model({
    hold: (message) => held.push(message),
    clearError: () => cleared.push(true),
  });

  command.hold("Say what you want done — an agent starting from nothing cannot guess.");

  assert.equal(held.length, 1, "the refusal still reaches NOT SENT");
  assert.equal(cleared.length, 1, "and the stale red line goes with it");
});

// `hold("")` is not a generic dismiss. The controller only reaches it AFTER a command pill
// and runner are found, so it means exactly "a new staged attempt has begun" — and a new
// attempt supersedes the previous result, the same rule an ordinary send already follows.
// If this one fails it writes its own red line.
test("a fresh command attempt retires the previous result too", () => {
  const cleared = [];
  const command = model({ hold: () => {}, clearError: () => cleared.push(true) });

  command.hold("");

  assert.equal(cleared.length, 1, "the last attempt's red line is not this attempt's word");
});
