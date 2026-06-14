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

// Drain the loader's async prefetch burst (microtask chain) by yielding a
// macrotask, after which `pending` has cleared and a fresh trigger can fire.
const flushBurst = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  await flushBurst();

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
  await flushBurst();
  await instances[0].trigger(true);
  assert.equal(calls, 2, "after a failure, the next intersection should still load");
});

test("keeps prefetching within a burst while the consumer reports more pages", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  // true → "page loaded, more remain"; false → "that was the last page".
  const results = [true, true, false];
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      const value = results[calls] ?? false;
      calls += 1;
      return value;
    },
    // scrollTop stays within the 600px prefetch band, so the only thing that
    // stops the burst is the consumer reporting no more pages.
    scrollElement: makeScrollEl({ scrollTop: 0 }),
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(
    calls,
    3,
    "a single intersection should keep loading until prev_cursor is exhausted"
  );
});

test("stops prefetching once enough history is buffered above the fold", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      return true; // always more, but the band check should stop the burst
    },
    // scrollTop is well past the 600px band, so one page is enough for now.
    scrollElement: makeScrollEl({ scrollTop: 1000 }),
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 1, "a filled band should not keep prefetching");
});

test("caps the number of pages prefetched in a single burst", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      return true; // never-ending history + pinned sentinel
    },
    scrollElement: makeScrollEl({ scrollTop: 0 }),
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 8, "the burst must stop at MAX_PREFETCH_PAGES_PER_BURST");
});

test("reschedules past the per-burst cap while the band keeps filling", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      // Each short page nudges the viewport down a little (like overflow-anchor
      // after a prepend), but not enough to fill the 600px band in eight pages.
      scrollEl.scrollTop += 60;
      return true; // always more history; the band check is what stops us
    },
    scrollElement: scrollEl,
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  await flushBurst();
  // 600px band / 60px per page ⇒ ~11 pages, i.e. past the 8-page cap, with no
  // second user-driven intersection. The burst must self-reschedule.
  assert.ok(calls > 8, `expected loading to continue past the cap, got ${calls}`);
  assert.ok(scrollEl.scrollTop > 600, "should stop only once the band is full");
});

test("a sync poke resumes a burst that stalled before the cursor was ready", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  scrollEl.setSentinel({ id: "sentinel" });
  let cursorReady = false;
  let calls = 0;

  const { sync } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      // Mid-hydration the older cursor isn't known yet (null = transient); once
      // it is, the single page loads and reports it's the oldest (false).
      return cursorReady ? false : null;
    },
    scrollElement: scrollEl,
  });

  sync();
  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 1, "the first burst backs off when there's no cursor yet");

  // Hydration completes, exposing the cursor; a re-render calls sync().
  cursorReady = true;
  sync();
  await flushBurst();
  assert.equal(
    calls,
    2,
    "a poke after the cursor is ready resumes loading without a new intersection"
  );
});

test("a stalled burst stays quiet on pokes until the cursor is ready", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  scrollEl.setSentinel({ id: "sentinel" });
  let calls = 0;

  const { sync } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      return null; // never ready: every poke that loads must back off again
    },
    scrollElement: scrollEl,
  });

  sync();
  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 1);

  // Each render re-pokes; the loader retries at most once per poke (no spin).
  sync();
  await flushBurst();
  sync();
  await flushBurst();
  assert.equal(calls, 3, "one retry per poke, never a busy loop");
});

test("a non-true onLoad result loads exactly one page per trigger", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      // Consumers that don't report a boolean (view-only pin, remote paths
      // that ignore the cursor) keep the legacy one-page-per-trigger behavior.
    },
    scrollElement: makeScrollEl({ scrollTop: 0 }),
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 1, "undefined result should not start a prefetch loop");
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
