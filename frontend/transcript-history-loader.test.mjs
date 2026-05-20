import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRANSCRIPT_HISTORY_ROOT_MARGIN,
  attachTranscriptHistoryLoader,
  createTranscriptHistoryLoader,
} from "./shared/transcript-history-loader.js";

// Minimal IntersectionObserver double. Records observe/disconnect calls and
// exposes `trigger(isIntersecting)` to simulate the browser firing the
// callback. This is intentionally not a full IO polyfill — we only need
// enough to validate the loader's gating logic.
function makeFakeObserverFactory() {
  const instances = [];

  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      this.disconnected = false;
      instances.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
    disconnect() {
      this.disconnected = true;
    }
    // Test helper: fire the callback with the given intersection state.
    async trigger(isIntersecting) {
      this.callback(
        this.observed.map((target) => ({ isIntersecting, target }))
      );
      // Let the loader's microtask chain settle so the pending flag clears
      // before the next assertion.
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  return { FakeObserver, instances };
}

function makeScrollEl({ scrollTop = 0 } = {}) {
  return {
    _children: new Map(),
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTop,
    querySelector(selector) {
      return this._children.get(selector) || null;
    },
    setSentinel(sentinel) {
      this._children.set("[data-transcript-history-sentinel]", sentinel);
    },
  };
}

// --- createTranscriptHistoryLoader -----------------------------------------

test("fires onLoad when the sentinel becomes intersecting", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
    },
    scrollElement: makeScrollEl(),
    sentinelElement: { id: "sentinel" },
  });

  assert.equal(instances.length, 1);
  assert.equal(instances[0].observed.length, 1);
  assert.equal(instances[0].options.rootMargin, DEFAULT_TRANSCRIPT_HISTORY_ROOT_MARGIN);

  await instances[0].trigger(true);
  assert.equal(calls, 1);

  dispose();
  assert.equal(instances[0].disconnected, true);
});

test("does not fire onLoad when the sentinel reports not intersecting", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
    },
    scrollElement: makeScrollEl(),
    sentinelElement: {},
  });

  await instances[0].trigger(false);
  assert.equal(calls, 0);
});

test("coalesces overlapping intersecting events into a single onLoad", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  let release;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () =>
      new Promise((resolve) => {
        calls += 1;
        release = resolve;
      }),
    scrollElement: makeScrollEl(),
    sentinelElement: {},
  });

  await instances[0].trigger(true);
  await instances[0].trigger(true);
  await instances[0].trigger(true);
  assert.equal(calls, 1, "re-firing while pending should not fan out");

  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  await instances[0].trigger(true);
  assert.equal(calls, 2, "after the previous fetch settles, a fresh trigger should load again");
});

test("swallows onLoad errors so the observer stays usable", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      throw new Error("network down");
    },
    scrollElement: makeScrollEl(),
    sentinelElement: {},
  });

  await instances[0].trigger(true);
  await instances[0].trigger(true);
  assert.equal(calls, 2, "after a failure, the next intersection should still load");
});

test("returns a noop disposer when prerequisites are missing", () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {},
    scrollElement: null,
    sentinelElement: { id: "sentinel" },
  });
  assert.equal(instances.length, 0);
  // Should not throw.
  dispose();
});

// --- attachTranscriptHistoryLoader (lifecycle wrapper) ---------------------

test("attachTranscriptHistoryLoader observes whichever sentinel is currently in the DOM", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl();
  let calls = 0;

  const sentinelA = { id: "A" };
  scrollEl.setSentinel(sentinelA);

  const { sync, detach } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
    },
    scrollElement: scrollEl,
  });

  sync();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].observed[0], sentinelA);

  // No-op when the sentinel hasn't changed.
  sync();
  assert.equal(instances.length, 1);

  // Swap the sentinel (simulates React replacing the DOM node when the
  // TranscriptContent branch swaps).
  const sentinelB = { id: "B" };
  scrollEl.setSentinel(sentinelB);
  sync();
  assert.equal(instances.length, 2);
  assert.equal(instances[0].disconnected, true);
  assert.equal(instances[1].observed[0], sentinelB);

  await instances[1].trigger(true);
  assert.equal(calls, 1);

  detach();
  assert.equal(instances[1].disconnected, true);
});

test("attachTranscriptHistoryLoader tears down when the sentinel disappears", () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl();
  scrollEl.setSentinel({ id: "A" });

  const { sync, detach } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {},
    scrollElement: scrollEl,
  });

  sync();
  assert.equal(instances.length, 1);

  scrollEl._children.delete("[data-transcript-history-sentinel]");
  sync();
  assert.equal(instances[0].disconnected, true);

  detach(); // safe to call after already detached
});

test("scroll fallback fires onLoad when IntersectionObserver is unavailable", async () => {
  let listener = null;
  const scrollEl = {
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    removeEventListener: () => {
      listener = null;
    },
    scrollTop: 0,
  };
  let calls = 0;

  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 0;
  };

  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: null,
    onLoad: () => {
      calls += 1;
    },
    scrollElement: scrollEl,
    sentinelElement: { id: "sentinel" },
  });

  assert.equal(typeof listener, "function");
  scrollEl.scrollTop = 4;
  listener();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);

  scrollEl.scrollTop = 400;
  listener();
  await Promise.resolve();
  assert.equal(calls, 1, "fallback should respect the 80px threshold");

  dispose();
  delete globalThis.requestAnimationFrame;
});
