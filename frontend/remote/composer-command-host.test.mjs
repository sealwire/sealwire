import test from "node:test";
import assert from "node:assert/strict";

import { attachComposerCommands } from "./composer-command-host.js";

function fakeController() {
  const controller = {
    destroyed: 0,
    submit: () => null,
    destroy() {
      controller.destroyed += 1;
    },
  };
  return controller;
}

test("nothing is attached before the textarea exists", () => {
  let built = 0;
  const attached = attachComposerCommands({
    input: null,
    mount: {},
    buildOptions: () => ({}),
    createController: () => {
      built += 1;
      return fakeController();
    },
  });

  assert.equal(built, 0, "a controller with no field to read would be inert anyway");
  assert.equal(attached.controller, null);
  attached.release();
});

test("the field and the mount reach the controller", () => {
  const input = { id: "remote-message-input" };
  const mount = { id: "mount" };
  let seen = null;
  attachComposerCommands({
    input,
    mount,
    buildOptions: () => ({ log: () => {} }),
    createController: (options) => {
      seen = options;
      return fakeController();
    },
  });

  assert.equal(seen.input, input);
  assert.equal(seen.mount, mount);
  assert.equal(typeof seen.log, "function", "options from the caller are passed through");
});

test("releasing lets go of the textarea", () => {
  const controller = fakeController();
  const attached = attachComposerCommands({
    input: {},
    mount: {},
    buildOptions: () => ({}),
    createController: () => controller,
  });

  attached.release();

  assert.equal(
    controller.destroyed,
    1,
    "a controller left holding a remounted surface's old textarea answers for a field nobody can type into"
  );
});

test("a controller without a teardown is released without throwing", () => {
  // The public placeholder returns only `submit`, and a public checkout must not
  // crash on unmount because of it.
  const attached = attachComposerCommands({
    input: {},
    mount: {},
    buildOptions: () => ({}),
    createController: () => ({ submit: () => null }),
  });

  assert.doesNotThrow(() => attached.release());
});
