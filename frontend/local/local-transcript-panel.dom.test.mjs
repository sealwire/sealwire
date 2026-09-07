// LocalTranscriptPanel owns the six branches renderTranscript used to pick
// imperatively (render-session.js) plus the transcript history loader's
// attach/sync/detach lifecycle. This drives the REAL component through jsdom
// (not a source-text slice) so the branch dispatch, the layout-effect order,
// and the loader's real IntersectionObserver wiring are all exercised as they
// actually run.
//
// Kept in its own file so the DOM globals below don't leak into the static
// suite (mirrors use-transcript-scroll-bookkeeping.dom.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalTranscriptPanel } = await import("./local-transcript-panel.js");

const h = React.createElement;

// Counts construct/disconnect so "exactly one live observer" can be asserted
// against the real attachTranscriptHistoryLoader path, not a mock of it.
// Also keeps each instance (with its captured callback) so a test can fire a
// real intersection and drive the loader's own state machine instead of
// calling attachTranscriptHistoryLoader's internals directly.
function installFakeIntersectionObserver() {
  const counts = { constructs: 0, disconnects: 0 };
  const instances = [];
  class FakeIntersectionObserver {
    constructor(callback) {
      counts.constructs += 1;
      this.callback = callback;
      instances.push(this);
    }
    observe() {}
    disconnect() {
      counts.disconnects += 1;
    }
    unobserve() {}
  }
  global.IntersectionObserver = FakeIntersectionObserver;
  return { counts, instances };
}

// createTranscriptHistoryLoader's promise chain (scheduleBurst -> runPrefetchBurst
// -> await onLoad()) is a handful of microtask hops deep; chaining .then()s (rather
// than a single await) waits out all of them without depending on their exact count.
function flushMicrotasks(times = 30) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => {});
  }
  return chain;
}

// `salt` mints a distinct user-entry id for a thread the test already visited
// under the same id, so a fire-once check exercises a genuinely fresh
// message instead of accidentally colliding with one already anchored.
function entriesFor(count, salt = "") {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `item${salt}-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `line ${index}`,
  }));
}

function baseProps(overrides = {}) {
  return {
    activeThreadId: null,
    activeThreadLabel: "",
    approval: null,
    buildTranscriptOptions: () => ({}),
    entries: [],
    entriesCanWrite: true,
    getStandbyEmptyContent: () => h("div", { className: "standby-empty-marker" }, "Standby"),
    hydrationLoading: false,
    onLoadOlderTranscript: () => {},
    promotion: null,
    readyCopy: "The agent is connected.",
    requestedSessionLabel: "",
    resetEpoch: 0,
    scrollElement: null,
    session: { active_thread_id: null },
    shortId: (value) => (value ? String(value).slice(0, 8) : "unknown"),
    standbyCanWrite: true,
    viewOnly: false,
    viewOnlyReviewView: false,
    viewedThreadLocked: false,
    viewedThreadWorkflowLocked: false,
    viewingConversation: true,
    viewingDifferentThread: false,
    ...overrides,
  };
}

// Scroll-bookkeeping coverage below needs real geometry: height derives from
// the rendered entries and scrollTop clamps like a real browser's. The
// hook's own exhaustive behavior coverage lives in
// local-transcript-scroll-bookkeeping.dom.test.mjs; these tests only prove
// the panel wires activeThreadId/mode/promotion/resetEpoch through to it.
const SCROLL_CLIENT_HEIGHT = 266;
const SCROLL_ROW_HEIGHT = 46;
const scrollLaidOut = new WeakSet();
function installScrollLayout(element) {
  if (scrollLaidOut.has(element)) {
    return;
  }
  scrollLaidOut.add(element);
  let top = 0;
  const maxScrollTop = () => Math.max(0, element.scrollHeight - element.clientHeight);
  Object.defineProperty(element, "clientHeight", { get: () => SCROLL_CLIENT_HEIGHT });
  Object.defineProperty(element, "scrollHeight", {
    get: () =>
      Math.max(
        SCROLL_CLIENT_HEIGHT,
        element.querySelectorAll("[data-transcript-entry-id]").length * SCROLL_ROW_HEIGHT
      ),
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => {
      top = Math.min(top, maxScrollTop());
      return top;
    },
    set: (value) => {
      top = Math.max(0, Math.min(Number(value) || 0, maxScrollTop()));
    },
  });
}

function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render(overrides = {}) {
      act(() => root.render(h(LocalTranscriptPanel, baseProps({ scrollElement: host, ...overrides }))));
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("branch 1: a review or Code Flow lock on the viewed thread shows its own copy", () => {
  const view = mount();
  try {
    view.render({ viewingConversation: false, viewedThreadLocked: true });
    assert.match(view.host.textContent, /Review in progress/);
    assert.match(view.host.textContent, /Another agent is reviewing this conversation/);

    view.render({
      viewingConversation: false,
      viewedThreadLocked: true,
      viewedThreadWorkflowLocked: true,
    });
    assert.match(view.host.textContent, /Code Flow in progress/);
  } finally {
    view.unmount();
  }
});

test("branch 2: viewing a different, not-yet-active thread shows Loading session with its label", () => {
  const view = mount();
  try {
    view.render({
      viewingConversation: false,
      viewingDifferentThread: true,
      requestedSessionLabel: "thread-abc",
    });
    assert.match(view.host.textContent, /Loading session/);
    assert.match(view.host.textContent, /Requested session: thread-abc/);
  } finally {
    view.unmount();
  }
});

test("branch 3: a live session running elsewhere shows Relay console home with its label", () => {
  const view = mount();
  try {
    view.render({
      viewingConversation: false,
      activeThreadId: "thread-live",
      activeThreadLabel: "Live Thread",
    });
    assert.match(view.host.textContent, /Relay console home/);
    assert.match(view.host.textContent, /Current session: Live Thread/);
  } finally {
    view.unmount();
  }
});

test("branch 4: a not-yet-loaded view-only thread shows a read-only or review placeholder", () => {
  const view = mount();
  try {
    view.render({ entries: [], viewOnly: true, viewOnlyReviewView: false });
    assert.match(view.host.textContent, /Read-only view/);

    view.render({ entries: [], viewOnly: true, viewOnlyReviewView: true });
    assert.match(view.host.textContent, /Review in progress/);
    assert.match(view.host.textContent, /Loading this session's conversation/);
  } finally {
    view.unmount();
  }
});

test("branch 5: empty + no approval renders the standby thunk only when there is no active thread", () => {
  const view = mount();
  let standbyCalls = 0;
  try {
    view.render({
      entries: [],
      approval: null,
      activeThreadId: null,
      getStandbyEmptyContent: () => {
        standbyCalls += 1;
        return h("div", { className: "standby-empty-marker" }, "Standby");
      },
    });
    assert.match(view.host.textContent, /Standby/);
    assert.equal(standbyCalls, 1);

    // With an active thread, branch 5 shows the ready/waiting copy instead,
    // and must NOT call the standby thunk.
    view.render({
      entries: [],
      approval: null,
      activeThreadId: "thread-1",
      readyCopy: "Ready copy marker",
      standbyCanWrite: true,
      getStandbyEmptyContent: () => {
        standbyCalls += 1;
        return h("div", null, "should not render");
      },
    });
    assert.match(view.host.textContent, /Ready copy marker/);
    assert.equal(standbyCalls, 1, "the standby thunk must not be called once there is an active thread");
  } finally {
    view.unmount();
  }
});

test("branch 6: entries render through TranscriptPane and call the transcript-options builder", () => {
  const view = mount();
  let optionsCalls = 0;
  try {
    view.render({
      entries: entriesFor(2),
      buildTranscriptOptions: () => {
        optionsCalls += 1;
        return {};
      },
    });
    assert.match(view.host.textContent, /line 0/);
    assert.match(view.host.textContent, /line 1/);
    assert.equal(optionsCalls, 1);
    assert.ok(
      view.host.querySelector("[data-transcript-history-sentinel]"),
      "the entries branch renders the real history sentinel"
    );
  } finally {
    view.unmount();
  }
});

test("buildTranscriptOptions runs exactly once in the entries branch, never in the other five, and receives activeThreadId/entries/session", () => {
  const view = mount();
  const calls = [];
  const buildTranscriptOptions = (input) => {
    calls.push(input);
    return {};
  };
  const session = { active_thread_id: null, marker: "the-session" };
  try {
    view.render({
      viewingConversation: false,
      viewedThreadLocked: true,
      buildTranscriptOptions,
      session,
    });
    assert.equal(calls.length, 0, "branch 1 must not call the builder");

    view.render({
      viewingConversation: false,
      viewingDifferentThread: true,
      buildTranscriptOptions,
      session,
    });
    assert.equal(calls.length, 0, "branch 2 must not call the builder");

    view.render({
      viewingConversation: false,
      activeThreadId: "thread-live",
      buildTranscriptOptions,
      session,
    });
    assert.equal(calls.length, 0, "branch 3 must not call the builder");

    view.render({ entries: [], viewOnly: true, buildTranscriptOptions, session });
    assert.equal(calls.length, 0, "branch 4 must not call the builder");

    view.render({ entries: [], approval: null, activeThreadId: null, buildTranscriptOptions, session });
    assert.equal(calls.length, 0, "branch 5 must not call the builder");

    const entries = entriesFor(2);
    view.render({ entries, activeThreadId: "thread-a", buildTranscriptOptions, session });
    assert.equal(calls.length, 1, "the entries branch calls the builder exactly once");
    assert.deepEqual(calls[0], { activeThreadId: "thread-a", entries, session });
  } finally {
    view.unmount();
  }
});

test("branch 5 falls through to branch 6 when approval is truthy with zero entries", () => {
  const view = mount();
  try {
    view.render({ entries: [], approval: { summary: "Needs approval" } });
    assert.ok(
      view.host.querySelector("[data-transcript-history-sentinel]"),
      "an approval with zero entries must render through the entries path (with its sentinel), not the ready/standby state"
    );
  } finally {
    view.unmount();
  }
});

test("branches 1-4 never run a scroll action; branches 5/6 do, and a branch-5 first message anchors fresh", () => {
  const view = mount();
  installScrollLayout(view.host);
  try {
    // Branch 6 lands on thread-a and the reader escapes to read history.
    view.render({ activeThreadId: "thread-a", entries: entriesFor(8) });
    const bottom = view.host.scrollTop;
    view.host.scrollTop = bottom - 40;

    // None of branches 1-4 may run a scroll action -- proven below by the
    // retained offset surviving all four untouched.
    view.render({ viewingConversation: false, viewedThreadLocked: true });
    view.render({ viewingConversation: false, viewingDifferentThread: true });
    view.render({ viewingConversation: false, activeThreadId: "thread-live" });
    view.render({ entries: [], viewOnly: true });

    view.render({ activeThreadId: "thread-a", entries: entriesFor(8) });
    assert.equal(
      view.host.scrollTop,
      bottom - 40,
      "branches 1-4 must not have run a scroll action against thread-a's retained offset"
    );

    // Branch 5 (a genuinely empty, ready thread) runs its own scroll action
    // too: its first message must anchor at a fresh bottom, not restore
    // stale history -- the observable proof branch 5 staged a commit (see
    // local-transcript-scroll-bookkeeping.dom.test.mjs for the mechanism).
    // Row count stays under transcript-react.js's virtualization threshold
    // (20) so every row actually lands in the DOM for the fake layout to see.
    view.render({ entries: [], approval: null, activeThreadId: "thread-b" });
    view.render({ entries: entriesFor(15), activeThreadId: "thread-b" });
    assert.equal(
      view.host.scrollTop,
      15 * SCROLL_ROW_HEIGHT - SCROLL_CLIENT_HEIGHT,
      "branch 5's own scroll action landed the first message at a fresh bottom"
    );
  } finally {
    view.unmount();
  }
});

test("a promotion prop reaches the hook and rekeys the retained offset onto the new thread id", () => {
  const view = mount();
  installScrollLayout(view.host);
  try {
    view.render({ activeThreadId: "pend-A", entries: entriesFor(8) });
    const bottom = view.host.scrollTop;
    view.host.scrollTop = bottom - 40;
    view.render({ activeThreadId: "decoy", entries: [] }); // evicts pend-A's offset

    const promotion = { from: "pend-A", to: "real-A" };
    view.render({ activeThreadId: "real-A", entries: entriesFor(15), promotion });
    assert.equal(
      view.host.scrollTop,
      bottom - 40,
      "the promotion prop must reach the hook and rekey pend-A's retained offset onto real-A"
    );
  } finally {
    view.unmount();
  }
});

test("a resetEpoch bump reaches the hook and clears the retained offset", () => {
  const view = mount();
  installScrollLayout(view.host);
  try {
    view.render({ activeThreadId: "thread-a", entries: entriesFor(8), resetEpoch: 0 });
    const bottom = view.host.scrollTop;
    view.host.scrollTop = bottom - 40;
    view.render({ activeThreadId: "decoy", entries: [], resetEpoch: 0 }); // evicts the offset

    view.render({ activeThreadId: "thread-a", entries: entriesFor(8), resetEpoch: 1 });
    assert.equal(
      view.host.scrollTop,
      bottom,
      "the resetEpoch bump must reach the hook and clear the retained offset"
    );
  } finally {
    view.unmount();
  }
});

test("the history loader syncs to whichever sentinel is live, with exactly one observer alive across a branch swap, and detaches on unmount", () => {
  const { counts } = installFakeIntersectionObserver();
  const view = mount();
  try {
    view.render({ entries: entriesFor(2) });
    assert.equal(counts.constructs, 1, "the entries branch attaches one observer");
    assert.equal(counts.constructs - counts.disconnects, 1, "exactly one live observer");

    view.render({ viewingConversation: false, viewedThreadLocked: true });
    assert.equal(counts.disconnects, 1, "losing the sentinel must disconnect the old observer");
    assert.equal(counts.constructs - counts.disconnects, 0, "no observer is left live without a sentinel");

    view.render({ entries: entriesFor(3) });
    assert.equal(counts.constructs, 2, "the sentinel reappearing attaches a fresh observer");
    assert.equal(counts.constructs - counts.disconnects, 1, "still exactly one live observer, never two");
  } finally {
    view.unmount();
    delete global.IntersectionObserver;
  }
  assert.equal(counts.disconnects, 2, "unmounting the panel detaches the loader");
});

test("sync() resumes a loader that backed off awaiting an external poke, on a same-branch re-render with no sentinel change", async () => {
  // The bug this guards: sync() only rebuilds the loader when the sentinel node
  // ITSELF changes. A commit that stays on branch 6 (same sentinel) still runs
  // sync() every time, but earlier coverage only ever exercised that call on an
  // unchanged, already-satisfied loader — never on one sitting in the real
  // "attach-transcript-history-loader.js" backoff state, so a `sync()` that quietly
  // stopped poking it would not have been caught.
  const { instances } = installFakeIntersectionObserver();
  const view = mount();
  const onLoadCalls = [];
  // Always "not definitive" (neither true nor false): the exact shape that makes
  // the real loader set awaitingExternalPoke and stop rescheduling itself.
  const onLoadOlderTranscript = () => {
    onLoadCalls.push(true);
    return Promise.resolve(undefined);
  };
  try {
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the entries branch attaches one observer");

    // Drive the REAL loader's state machine: an intersection starts a burst.
    instances[0].callback([{ isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(onLoadCalls.length, 1, "the intersection triggers exactly one load attempt");

    // The loader is now backed off and will not fire again on its own. A
    // re-render that stays on branch 6 (same entries shape, same sentinel node)
    // must still call sync() — and sync()'s poke() must resume it.
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the sentinel is unchanged, so sync() must not rebuild the observer");
    await flushMicrotasks();
    assert.equal(
      onLoadCalls.length,
      2,
      "sync() after a same-branch, same-sentinel commit must poke the backed-off loader back into loading"
    );
  } finally {
    view.unmount();
    delete global.IntersectionObserver;
  }
});

test("unmounting while a load is pending does not leak a duplicate onLoad call", async () => {
  // AC2: disconnecting the observer on unmount is not enough — the loader's
  // own in-flight burst (awaiting onLoad()) survives disconnect(), and a
  // `true` result landing after unmount must not schedule another load.
  const { instances } = installFakeIntersectionObserver();
  const view = mount();
  const onLoadCalls = [];
  let release;
  const onLoadOlderTranscript = () =>
    new Promise((resolve) => {
      onLoadCalls.push(true);
      release = resolve;
    });
  try {
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the entries branch attaches one observer");

    instances[0].callback([{ isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(onLoadCalls.length, 1, "the intersection starts one load");

    // Unmount while that load is still in flight.
    view.unmount();

    // The already-in-flight call finally resolves, reporting more pages.
    release(true);
    await flushMicrotasks();
    assert.equal(
      onLoadCalls.length,
      1,
      "a load result arriving after unmount must not schedule another load"
    );
  } finally {
    delete global.IntersectionObserver;
  }
});

test("a branch swap that removes the sentinel while a load is pending does not leak a duplicate onLoad call", async () => {
  // Same AC2 leak as the unmount case above, but reached through sync()'s own
  // teardown of a superseded sentinel (render-session.js drives this on every
  // branch swap, not just unmount) rather than the panel's own cleanup.
  const { instances } = installFakeIntersectionObserver();
  const view = mount();
  const onLoadCalls = [];
  let release;
  const onLoadOlderTranscript = () =>
    new Promise((resolve) => {
      onLoadCalls.push(true);
      release = resolve;
    });
  try {
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    assert.equal(instances.length, 1, "the entries branch attaches one observer");

    instances[0].callback([{ isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(onLoadCalls.length, 1, "the intersection starts one load");

    // The branch swaps away from entries (sentinel removed) while that load
    // is still in flight — the panel's sync() disposes the old instance.
    view.render({ viewingConversation: false, viewedThreadLocked: true, onLoadOlderTranscript });
    assert.equal(instances.length, 1, "no new observer is attached without a sentinel");

    // The already-in-flight call finally resolves, reporting more pages.
    release(true);
    await flushMicrotasks();
    assert.equal(
      onLoadCalls.length,
      1,
      "a load result arriving after the sentinel is removed must not schedule another load"
    );

    // The sentinel reappearing attaches an independent, unaffected loader.
    view.render({ entries: entriesFor(3), onLoadOlderTranscript });
    assert.equal(instances.length, 2, "the sentinel reappearing attaches a fresh observer");
    instances[1].callback([{ isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(onLoadCalls.length, 2, "the replacement loader still loads normally");
  } finally {
    view.unmount();
    delete global.IntersectionObserver;
  }
});

// --- scroll-fallback lifecycle (no IntersectionObserver) --------------------
//
// jsdom provides neither IntersectionObserver nor requestAnimationFrame, so
// simply NOT installing the fake above puts the panel on the real scroll
// fallback and its setTimeout(cb, 16) frame. Every other loader test here
// covers only the IntersectionObserver path.

// Past the fallback's own 16ms frame, so a still-live one would have fired.
const flushFallbackFrame = () => new Promise((resolve) => setTimeout(resolve, 40));

function assertOnFallbackPath() {
  assert.equal(
    typeof global.IntersectionObserver,
    "undefined",
    "precondition: no IntersectionObserver, so the panel uses the scroll fallback"
  );
}

test("scroll fallback: unmounting with a frame queued does not call onLoad afterwards", async () => {
  assertOnFallbackPath();
  const view = mount();
  const onLoadCalls = [];
  const onLoadOlderTranscript = () => {
    onLoadCalls.push(true);
  };

  view.render({ entries: entriesFor(2), onLoadOlderTranscript });
  // The fallback listens on the scroll element the panel was handed.
  view.host.dispatchEvent(new dom.window.Event("scroll"));

  view.unmount();
  await flushFallbackFrame();
  assert.deepEqual(
    onLoadCalls,
    [],
    "a fallback frame queued before unmount must not call onLoad afterwards"
  );
});

test("scroll fallback: a sentinel swap with a frame queued does not overlap the replacement loader", async () => {
  assertOnFallbackPath();
  const view = mount();
  const onLoadCalls = [];
  let generation = "first";
  const onLoadOlderTranscript = () => {
    onLoadCalls.push(generation);
  };

  try {
    view.render({ entries: entriesFor(2), onLoadOlderTranscript });
    view.host.dispatchEvent(new dom.window.Event("scroll"));

    // Branch swap removes the sentinel, so sync() disposes the loader while
    // its frame is still queued.
    view.render({ viewingConversation: false, viewedThreadLocked: true, onLoadOlderTranscript });
    await flushFallbackFrame();
    assert.deepEqual(onLoadCalls, [], "the superseded loader's queued frame must stay silent");

    // The sentinel returns; only this replacement loader may load.
    generation = "second";
    view.render({ entries: entriesFor(3), onLoadOlderTranscript });
    view.host.dispatchEvent(new dom.window.Event("scroll"));
    await flushFallbackFrame();
    assert.deepEqual(
      onLoadCalls,
      ["second"],
      "only the replacement loader loads, with no overlap from the detached one"
    );
  } finally {
    view.unmount();
  }
});
