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

test("dispose during an in-flight burst prevents a pending result from scheduling another load", async () => {
  // disconnect() alone doesn't stop runPrefetchBurst's own promise chain: a
  // `true` result arriving after dispose() would otherwise loop into another
  // onLoad call from an instance nothing owns any more.
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  let release;
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () =>
      new Promise((resolve) => {
        calls += 1;
        release = resolve;
      }),
    // Within the band, so an unguarded `true` result loops straight into a
    // second onLoad call.
    scrollElement: makeScrollEl({ scrollTop: 0 }),
    sentinelElement: { id: "sentinel" },
  });

  await instances[0].trigger(true);
  assert.equal(calls, 1, "the intersection starts the first load");

  // Torn down (sentinel removed, or the component unmounting) while that
  // first load is still in flight.
  dispose();
  assert.equal(instances[0].disconnected, true);

  // The already-in-flight call finally resolves, reporting more pages.
  release(true);
  await flushBurst();
  assert.equal(calls, 1, "a disposed loader must not act on a pending result by loading again");
});

test("a sentinel swap during an in-flight burst leaves only the replacement loader's observer alive", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  const sentinelA = { id: "A" };
  scrollEl.setSentinel(sentinelA);
  let calls = 0;
  let release;

  const { sync } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () =>
      new Promise((resolve) => {
        calls += 1;
        release = resolve;
      }),
    scrollElement: scrollEl,
  });

  sync();
  await instances[0].trigger(true);
  assert.equal(calls, 1, "the first sentinel's intersection starts a load");

  // The branch swaps to a new sentinel while that load is still in flight:
  // sync() tears down instances[0] and attaches a fresh loader to sentinelB.
  const sentinelB = { id: "B" };
  scrollEl.setSentinel(sentinelB);
  sync();
  assert.equal(instances.length, 2);
  assert.equal(instances[0].disconnected, true);

  // The old loader's in-flight call finally resolves, reporting more pages.
  release(true);
  await flushBurst();
  assert.equal(calls, 1, "the disposed loader must not fire a second, overlapping load");

  // The replacement loader is unaffected and still loads on its own intersection.
  await instances[1].trigger(true);
  assert.equal(calls, 2, "the replacement loader still loads normally");
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

test("the same sentinel loads history after switching from an exhausted thread", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  const sentinel = { id: "same-react-node" };
  scrollEl.setSentinel(sentinel);
  const loaded = [];
  let threadId = "finished";
  const { sync, detach } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      loaded.push(threadId);
      return threadId === "finished" ? false : true;
    },
    scrollElement: scrollEl,
  });

  sync(threadId);
  await instances[0].trigger(true);
  await flushBurst();
  assert.deepEqual(loaded, ["finished"]);

  // React reuses the top sentinel across transcript tabs. The old loader has
  // reachedTop=true, and a later cursor on this different thread must get a
  // fresh observer even though the DOM node did not change.
  threadId = "has-history";
  sync(threadId);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].disconnected, true);
  await instances[1].trigger(true);
  await flushBurst();
  assert.ok(loaded.includes("has-history"));
  detach();
});

test("an upward gesture at the top retries when the observer misses a transition", async () => {
  const { FakeObserver } = makeFakeObserverFactory();
  const listeners = new Map();
  const scrollEl = {
    scrollTop: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let calls = 0;
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => { calls += 1; return false; },
    scrollElement: scrollEl,
    sentinelElement: {},
  });

  // A zero-height sentinel or a clamped scroller need not emit a fresh IO or
  // scroll event. The gesture itself is still a request to see older history.
  listeners.get("wheel")?.({ deltaY: -120, ctrlKey: false });
  await flushBurst();
  assert.equal(calls, 1);
  dispose();
});

function makeGestureScrollEl({ scrollTop = 0 } = {}) {
  const listeners = new Map();
  return {
    listeners,
    scrollTop,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    fire(type, event) { listeners.get(type)?.(event); },
  };
}

test("a finger pulling down at the top retries a loader the observer left idle", async () => {
  const { FakeObserver } = makeFakeObserverFactory();
  const scrollEl = makeGestureScrollEl({ scrollTop: 0 });
  let calls = 0;
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => { calls += 1; return false; },
    scrollElement: scrollEl,
    sentinelElement: {},
  });

  scrollEl.fire("touchstart", { touches: [{ clientY: 100 }] });
  scrollEl.fire("touchmove", { touches: [{ clientY: 140 }] });
  await flushBurst();
  assert.equal(calls, 1, "a pull at the clamped top is a request for older history");
  dispose();
});

test("gestures that do not ask for older history leave the loader alone", async () => {
  const { FakeObserver } = makeFakeObserverFactory();
  const nearTop = makeGestureScrollEl({ scrollTop: 0 });
  const farDown = makeGestureScrollEl({ scrollTop: 5000 });
  let calls = 0;
  const onLoad = () => { calls += 1; return false; };
  const disposeNear = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver, onLoad, scrollElement: nearTop, sentinelElement: {},
  });
  const disposeFar = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver, onLoad, scrollElement: farDown, sentinelElement: {},
  });

  nearTop.fire("wheel", { deltaY: 120, ctrlKey: false });
  nearTop.fire("wheel", { deltaY: -120, ctrlKey: true });
  nearTop.fire("touchstart", { touches: [{ clientY: 140 }] });
  nearTop.fire("touchmove", { touches: [{ clientY: 100 }] });
  farDown.fire("wheel", { deltaY: -120, ctrlKey: false });
  await flushBurst();
  assert.equal(calls, 0, "scrolling down, pinch-zoom, and reading mid-history must not page");
  disposeNear();
  disposeFar();
});

test("a thread that reported no older pages still loads once history appears on it", async () => {
  // A read-only pin can collapse back to its live tail (with a cursor) after the
  // reader already reached its top, and a relay restart rebuilds the same thread.
  const { FakeObserver, instances } = makeFakeObserverFactory();
  const scrollEl = makeScrollEl({ scrollTop: 0 });
  scrollEl.setSentinel({ id: "sentinel" });
  let hasOlder = false;
  let calls = 0;
  const { sync, detach } = attachTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      return hasOlder ? true : false;
    },
    scrollElement: scrollEl,
  });

  sync("thread-a");
  await instances[0].trigger(true);
  await flushBurst();
  assert.equal(calls, 1);

  hasOlder = true;
  sync("thread-a");
  await flushBurst();
  assert.ok(calls > 1, "the re-render that exposed a cursor must resume paging");
  assert.equal(instances.length, 1, "same thread, same sentinel: no new observer");
  detach();
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

// --- scroll fallback lifecycle (no requestAnimationFrame) ------------------
//
// Node has no global requestAnimationFrame, so these exercise the real
// setTimeout(cb, 16) branch. The bug they pin: dispose() only ever tried
// cancelAnimationFrame, which cannot cancel a setTimeout, so a frame queued
// before teardown still fired and called onLoad afterwards.

// Long enough for the fallback's own 16ms timer to have fired if it were
// still live.
const flushFallbackFrame = () => new Promise((resolve) => setTimeout(resolve, 40));

function makeFallbackScrollEl({ scrollTop = 0 } = {}) {
  const listeners = new Set();
  return {
    scrollTop,
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
    // Only handlers still registered fire — a detached loader that forgot to
    // remove its listener would be caught here too.
    emitScroll() {
      for (const handler of [...listeners]) {
        handler();
      }
    },
    listenerCount: () => listeners.size,
  };
}

test("scroll fallback: detach cancels a frame queued before teardown so onLoad never fires", async () => {
  assert.equal(
    typeof globalThis.requestAnimationFrame,
    "undefined",
    "precondition: this test must exercise the setTimeout branch"
  );
  const scrollEl = makeFallbackScrollEl({ scrollTop: 0 });
  let calls = 0;

  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: null,
    onLoad: () => {
      calls += 1;
    },
    scrollElement: scrollEl,
    sentinelElement: { id: "sentinel" },
  });

  // A scroll queues the fallback frame, which is still pending 16ms out.
  scrollEl.emitScroll();
  assert.equal(calls, 0, "the frame has not run yet");

  // Torn down (unmount, or the sentinel being replaced) before it runs.
  dispose();
  assert.equal(scrollEl.listenerCount(), 0, "detach removes its scroll listener");

  await flushFallbackFrame();
  assert.equal(calls, 0, "a frame queued before detach must not call onLoad afterwards");
});

test("scroll fallback: a replacement loader does not overlap the detached one", async () => {
  assert.equal(
    typeof globalThis.requestAnimationFrame,
    "undefined",
    "precondition: this test must exercise the setTimeout branch"
  );
  const scrollEl = makeFallbackScrollEl({ scrollTop: 0 });
  const calls = [];

  const disposeFirst = createTranscriptHistoryLoader({
    ObserverCtor: null,
    onLoad: () => {
      calls.push("first");
    },
    scrollElement: scrollEl,
    sentinelElement: { id: "A" },
  });

  // The first loader has a frame in flight when its sentinel is replaced.
  scrollEl.emitScroll();
  disposeFirst();

  const disposeSecond = createTranscriptHistoryLoader({
    ObserverCtor: null,
    onLoad: () => {
      calls.push("second");
    },
    scrollElement: scrollEl,
    sentinelElement: { id: "B" },
  });
  assert.equal(scrollEl.listenerCount(), 1, "only the replacement loader is listening");

  scrollEl.emitScroll();
  await flushFallbackFrame();

  assert.deepEqual(
    calls,
    ["second"],
    "only the replacement loader may load; the detached one's queued frame must stay silent"
  );

  disposeSecond();
});

test("scroll fallback: a frame that survives cancellation is still suppressed by detach", async () => {
  // Environments that hand out a scheduler with no matching canceller (a
  // partial rAF polyfill) cannot be cleaned up by cancelling, so the callback
  // itself has to check whether it is still owned.
  const scrollEl = makeFallbackScrollEl({ scrollTop: 0 });
  let calls = 0;
  let queuedFrame = null;
  globalThis.requestAnimationFrame = (cb) => {
    queuedFrame = cb;
    return 1;
  };

  try {
    const dispose = createTranscriptHistoryLoader({
      ObserverCtor: null,
      onLoad: () => {
        calls += 1;
      },
      scrollElement: scrollEl,
      sentinelElement: { id: "sentinel" },
    });

    scrollEl.emitScroll();
    assert.equal(typeof queuedFrame, "function", "a frame is queued and uncancellable");

    dispose();
    // The environment runs it anyway — nothing could have cancelled it.
    queuedFrame();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 0, "a detached fallback's callback must not call onLoad");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("scroll fallback: detach cancels via the canceller matching how the frame was scheduled", async () => {
  // The original teardown always reached for cancelAnimationFrame, which
  // cannot cancel a setTimeout handle. Assert each branch hands its OWN handle
  // to its OWN canceller, rather than only observing that onLoad stayed quiet.
  const rafCancelled = [];
  const timeoutCancelled = [];
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    timeoutCancelled.push(handle);
    return realClearTimeout(handle);
  };

  try {
    // --- rAF available: cancelAnimationFrame gets the rAF handle ---
    globalThis.requestAnimationFrame = () => 4242;
    globalThis.cancelAnimationFrame = (handle) => rafCancelled.push(handle);
    const rafScrollEl = makeFallbackScrollEl({ scrollTop: 0 });
    const disposeRaf = createTranscriptHistoryLoader({
      ObserverCtor: null,
      onLoad: () => {},
      scrollElement: rafScrollEl,
      sentinelElement: { id: "raf" },
    });
    rafScrollEl.emitScroll();
    disposeRaf();
    assert.deepEqual(rafCancelled, [4242], "the rAF handle goes to cancelAnimationFrame");
    assert.deepEqual(timeoutCancelled, [], "clearTimeout is not used for a rAF handle");

    // --- rAF absent: clearTimeout gets the timeout handle ---
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    const timeoutScrollEl = makeFallbackScrollEl({ scrollTop: 0 });
    const disposeTimeout = createTranscriptHistoryLoader({
      ObserverCtor: null,
      onLoad: () => {},
      scrollElement: timeoutScrollEl,
      sentinelElement: { id: "timeout" },
    });
    timeoutScrollEl.emitScroll();
    disposeTimeout();
    assert.equal(timeoutCancelled.length, 1, "the timeout handle goes to clearTimeout");
    assert.deepEqual(rafCancelled, [4242], "no extra cancelAnimationFrame call");
  } finally {
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

// --- detach inside the queued-microtask window ------------------------------
//
// Both async paths check `disposed` and then queue a microtask before reaching
// onLoad. detach() landing inside that window still has to suppress the call.

test("observer path: detach after the intersection queues its burst, before the burst runs, suppresses onLoad", async () => {
  const { FakeObserver, instances } = makeFakeObserverFactory();
  let calls = 0;
  const dispose = createTranscriptHistoryLoader({
    ObserverCtor: FakeObserver,
    onLoad: () => {
      calls += 1;
      return true;
    },
    scrollElement: makeScrollEl({ scrollTop: 0 }),
    sentinelElement: { id: "sentinel" },
  });

  // Fire the callback WITHOUT awaiting: scheduleBurst has queued
  // runPrefetchBurst as a microtask that has not run yet.
  instances[0].callback([{ isIntersecting: true }]);
  dispose();

  await flushBurst();
  assert.equal(calls, 0, "a burst queued before detach must not reach onLoad");
});

test("scroll fallback: detach after the frame runs, before its queued microtask, suppresses onLoad", async () => {
  const scrollEl = makeFallbackScrollEl({ scrollTop: 0 });
  let calls = 0;
  let queuedFrame = null;
  globalThis.requestAnimationFrame = (cb) => {
    queuedFrame = cb;
    return 1;
  };

  try {
    const dispose = createTranscriptHistoryLoader({
      ObserverCtor: null,
      onLoad: () => {
        calls += 1;
      },
      scrollElement: scrollEl,
      sentinelElement: { id: "sentinel" },
    });

    scrollEl.emitScroll();
    // The frame body runs and queues Promise.then(onLoad) — but that microtask
    // has not run yet.
    queuedFrame();
    dispose();

    await flushBurst();
    assert.equal(calls, 0, "a microtask queued before detach must not reach onLoad");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});
