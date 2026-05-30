import test from "node:test";
import assert from "node:assert/strict";

import { createProgressTracker } from "./progress-tracker.mjs";

function fakeTimers() {
  const handlers = [];
  let nowValue = 1_000_000;
  return {
    setInterval(fn, ms) {
      const id = handlers.length + 1;
      handlers.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      const idx = handlers.findIndex((h) => h.id === id);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    now() {
      return nowValue;
    },
    advance(ms) {
      nowValue += ms;
    },
    fireAll() {
      for (const handler of [...handlers]) handler.fn();
    },
    activeCount() {
      return handlers.length;
    },
  };
}

function makeTracker(emits, fakes, overrides = {}) {
  return createProgressTracker({
    emit: (event) => emits.push(event),
    intervalMs: 5000,
    silenceMs: 5000,
    now: fakes.now,
    setIntervalFn: fakes.setInterval.bind(fakes),
    clearIntervalFn: fakes.clearInterval.bind(fakes),
    ...overrides,
  });
}

test("progress_tick fires after silence threshold", () => {
  const emits = [];
  const fakes = fakeTimers();
  const tracker = makeTracker(emits, fakes);

  tracker.start();
  fakes.advance(6000);
  fakes.fireAll();

  assert.equal(emits.length, 1);
  assert.equal(emits[0].type, "progress_tick");
  assert.equal(emits[0].phase, "thinking");
});

test("recent event suppresses the next tick", () => {
  const emits = [];
  const fakes = fakeTimers();
  const tracker = makeTracker(emits, fakes);

  tracker.start();
  fakes.advance(3000);
  tracker.record({ type: "assistant_delta", text: "hi" });
  fakes.advance(2000);
  fakes.fireAll();

  assert.equal(
    emits.filter((event) => event.type === "progress_tick").length,
    0,
  );
});

test("tool_call_requested sets phase=tool and tool name", () => {
  const emits = [];
  const fakes = fakeTimers();
  const tracker = makeTracker(emits, fakes);

  tracker.start();
  tracker.record({ type: "tool_call_requested", id: "t1", name: "Bash" });

  assert.equal(tracker.phase, "tool");
  assert.equal(tracker.currentTool, "Bash");

  fakes.advance(6000);
  fakes.fireAll();

  const tick = emits.find((event) => event.type === "progress_tick");
  assert.ok(tick);
  assert.equal(tick.phase, "tool");
  assert.equal(tick.tool, "Bash");
});

test("progress_tick carries this tracker provider session id", () => {
  const emits = [];
  const fakes = fakeTimers();
  const tracker = makeTracker(emits, fakes);

  tracker.start();
  tracker.record({
    type: "assistant_delta",
    text: "hi",
    provider_session_id: "session-1",
  });
  fakes.advance(6000);
  fakes.fireAll();

  const tick = emits.find((event) => event.type === "progress_tick");
  assert.ok(tick);
  assert.equal(tick.provider_session_id, "session-1");
});

test("tool_call_result clears tool when no more are pending", () => {
  const fakes = fakeTimers();
  const tracker = makeTracker([], fakes);

  tracker.start();
  tracker.record({ type: "tool_call_requested", id: "t1", name: "Bash" });
  tracker.record({ type: "tool_call_result", id: "t1" });

  assert.equal(tracker.phase, "thinking");
  assert.equal(tracker.currentTool, null);
});

test("tool_call_result keeps phase=tool when other tools remain", () => {
  const fakes = fakeTimers();
  const tracker = makeTracker([], fakes);

  tracker.start();
  tracker.record({ type: "tool_call_requested", id: "t1", name: "Bash" });
  tracker.record({ type: "tool_call_requested", id: "t2", name: "Read" });
  tracker.record({ type: "tool_call_result", id: "t1" });

  assert.equal(tracker.phase, "tool");
  assert.ok(tracker.currentTool === "Read" || tracker.currentTool === "Bash");
});

test("done stops the ticker", () => {
  const emits = [];
  const fakes = fakeTimers();
  const tracker = makeTracker(emits, fakes);

  tracker.start();
  assert.equal(fakes.activeCount(), 1);
  tracker.record({ type: "done" });

  assert.equal(fakes.activeCount(), 0);
  assert.equal(tracker.isRunning, false);
  assert.equal(tracker.phase, null);
  assert.equal(tracker.currentTool, null);
});

test("approval_requested switches phase to waiting_approval", () => {
  const fakes = fakeTimers();
  const tracker = makeTracker([], fakes);

  tracker.start();
  tracker.record({ type: "approval_requested" });

  assert.equal(tracker.phase, "waiting_approval");
});

test("start is idempotent", () => {
  const fakes = fakeTimers();
  const tracker = makeTracker([], fakes);

  tracker.start();
  tracker.start();
  tracker.start();

  assert.equal(fakes.activeCount(), 1);
});
