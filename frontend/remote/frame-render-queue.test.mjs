import assert from "node:assert/strict";
import test from "node:test";

import { createFrameRenderQueue } from "./frame-render-queue.js";

test("remote transcript renders at most once per animation frame", () => {
  const frames = [];
  const renders = [];
  let latest = "";
  const queue = createFrameRenderQueue({
    render() {
      renders.push(latest);
    },
    scheduleFrame(callback) {
      frames.push(callback);
    },
  });

  latest = "one";
  queue.queue();
  latest = "one two";
  queue.queue();
  latest = "one two three";
  queue.queue();

  assert.equal(frames.length, 1);
  assert.deepEqual(renders, []);

  frames.shift()();

  assert.deepEqual(renders, ["one two three"]);
});

test("remote transcript can schedule another render after the frame flushes", () => {
  const frames = [];
  let renderCount = 0;
  const queue = createFrameRenderQueue({
    render() {
      renderCount += 1;
    },
    scheduleFrame(callback) {
      frames.push(callback);
    },
  });

  queue.queue();
  frames.shift()();
  queue.queue();
  frames.shift()();

  assert.equal(renderCount, 2);
});

test("a synchronous flush invalidates its stale scheduled frame", () => {
  const frames = [];
  const renders = [];
  let latest = "delta";
  const queue = createFrameRenderQueue({
    render() {
      renders.push(latest);
    },
    scheduleFrame(callback) {
      frames.push(callback);
    },
  });

  queue.queue();
  queue.flush();
  latest = "authoritative snapshot";
  queue.queue();

  frames[0]();
  assert.deepEqual(renders, ["delta"]);

  frames[1]();
  assert.deepEqual(renders, ["delta", "authoritative snapshot"]);
});

test("cancelling a queued render invalidates its scheduled frame", () => {
  const frames = [];
  let renderCount = 0;
  const queue = createFrameRenderQueue({
    render() {
      renderCount += 1;
    },
    scheduleFrame(callback) {
      frames.push(callback);
    },
  });

  queue.queue();
  queue.cancel();
  frames[0]();

  assert.equal(renderCount, 0);
});
