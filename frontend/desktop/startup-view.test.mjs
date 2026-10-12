import { test } from "node:test";
import assert from "node:assert/strict";
import { startupView } from "./startup-view.mjs";

test("a starting or not-yet-known relay shows only the starting line", () => {
  for (const status of [undefined, null, { phase: "starting", logs: ["started relay-server"] }]) {
    const view = startupView(status);
    assert.equal(view.state, "starting");
    assert.equal(view.title, "Starting Sealwire…");
    assert.equal(view.canStart, false);
    assert.deepEqual(view.logs, [], "logs stay hidden until something goes wrong");
  }
});

test("a ready relay reads as opening, since the window is about to leave this page", () => {
  assert.equal(startupView({ phase: "ready", port: 8787, logs: [] }).title, "Opening Sealwire…");
});

// The app no longer starts its own relay unasked: with none running it waits here.
test("with no relay running the page offers to start one", () => {
  const view = startupView({ phase: "stopped", logs: [] });
  assert.equal(view.state, "stopped");
  assert.equal(view.title, "Sealwire isn't running");
  assert.match(view.detail, /terminal/);
  assert.equal(view.canStart, true);
  assert.deepEqual(view.logs, []);
});

test("a failure shows the reason, a start button, and only the latest log lines", () => {
  const logs = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const view = startupView({ phase: "failed", message: "relay-server: another relay is already running", logs });
  assert.equal(view.state, "failed");
  assert.equal(view.title, "Sealwire isn't running");
  assert.equal(view.detail, "relay-server: another relay is already running");
  assert.equal(view.canStart, true);
  assert.equal(view.logs.length, 40);
  assert.equal(view.logs.at(-1), "line 59");
});

test("a failure without a message still says something", () => {
  assert.equal(startupView({ phase: "failed" }).detail, "Sealwire stopped unexpectedly.");
});
