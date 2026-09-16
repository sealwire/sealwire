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
    actions: { setGoal: async () => ({}), askAgent: async () => ({}) },
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
