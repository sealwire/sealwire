// Perf proof for the remote delta hot path, shaped like
// frontend/transcript-hydration-perf.test.mjs and local's own
// frontend/local/session/stream-delta-perf.test.mjs: when the hydration
// window is loaded for a delta's own thread, applyTranscriptDelta writes into
// it in O(1) (applyTranscriptDeltaToWindow) and the array projection is
// deferred to settleTranscriptProjection, once per flush — not once per
// token, and not scaling with transcript size. Counters, not wall time: a
// wall-clock assertion is flaky in CI and proves nothing about complexity.
//
// Accepted trade-off, not a defect: while a background thread is pinned, the
// hydration window follows the PIN (there is one window, and it serves the
// thread on screen), so the LIVE thread's own deltas take the array
// fallback below and are therefore NOT O(1) during that window. This file
// only exercises the (default, un-pinned) windowed path the O(1) claim is
// actually about.

import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

let activeBrowser = null;

function createElementStub() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    className: "",
    placeholder: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    focus() {},
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

function createRequest() {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

function createIndexedDbStub() {
  const databases = new Map();
  function createDatabase() {
    const stores = new Map();
    return {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name, options = {}) {
        if (!stores.has(name)) {
          stores.set(name, { keyPath: options.keyPath || "id", records: new Map() });
        }
        return {};
      },
      transaction(name) {
        const storeState = stores.get(name);
        const transaction = {
          error: null,
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore() {
            return {
              get(key) {
                const request = createRequest();
                queueMicrotask(() => {
                  request.result = storeState.records.get(key);
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
              put(value) {
                const request = createRequest();
                queueMicrotask(() => {
                  storeState.records.set(value[storeState.keyPath], value);
                  request.result = value[storeState.keyPath];
                  request.onsuccess?.();
                  queueMicrotask(() => transaction.oncomplete?.());
                });
                return request;
              },
            };
          },
        };
        return transaction;
      },
      close() {},
    };
  }
  return {
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (!database) {
          database = createDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) {
          request.onupgradeneeded?.();
        }
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
}

function installBrowserStubs() {
  const storage = new Map();
  const elements = new Map();
  const pendingTimers = [];
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub());
      }
      return elements.get(selector);
    },
  };
  const windowObject = {
    localStorage,
    location: { href: "https://remote.example.test/" },
    history: { replaceState() {} },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: webcrypto,
    indexedDB: createIndexedDbStub(),
    setTimeout(callback) {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    clearTimeout(id) {
      pendingTimers[id - 1] = null;
    },
  };
  globalThis.document = document;
  globalThis.window = windowObject;
  globalThis.WebSocket = { OPEN: 1 };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: windowObject.indexedDB });
  activeBrowser = { elements };
  return activeBrowser;
}

function buildLargeSession(n) {
  const ids = Array.from({ length: n }, (_, i) => `item-${i}`);
  return {
    active_thread_id: "thread-1",
    transcript_revision: 0,
    transcript: ids.map((id, i) => ({
      item_id: id,
      kind: "agent_text",
      status: i === 0 ? "running" : "completed",
      text: i === 0 ? "" : `msg ${i} ${"x".repeat(120)}`,
      turn_id: `turn-${i}`,
      tool: null,
    })),
  };
}

function loadWindowFromSession(state, session) {
  state.transcriptHydrationThreadId = session.active_thread_id;
  state.transcriptHydrationEntries = new Map(
    session.transcript.map((entry) => [entry.item_id, { ...entry }])
  );
  state.transcriptHydrationOrder = session.transcript.map((entry) => entry.item_id);
}

// Shadows find/findIndex/map/includes as OWN properties on this one array
// instance (never touches Array.prototype, so nothing else in the test run is
// affected) and counts how many times any of them run. The per-token path
// must never touch the transcript array with any of these — the array
// projection is deferred to settle, and settle rebuilds from the hydration
// window's `order` array, never by scanning the old `.transcript`. `includes`
// is here because that is exactly what the order array's insert used to do —
// see the "brand-new item" test below.
function instrumentArrayScans(array) {
  const counts = { find: 0, findIndex: 0, map: 0, includes: 0 };
  for (const method of Object.keys(counts)) {
    const original = Array.prototype[method];
    Object.defineProperty(array, method, {
      configurable: true,
      value(...args) {
        counts[method] += 1;
        return original.apply(this, args);
      },
    });
  }
  return {
    total: () => counts.find + counts.findIndex + counts.map + counts.includes,
    counts,
  };
}

test("with a loaded hydration window, the delta path never rebuilds the array before a flush, and rebuilds exactly once per flush, independent of transcript size", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
    clearSessionRuntime,
    __readTranscriptDeltaRebuildCount,
    __resetTranscriptDeltaRebuildCount,
  } = await import("./session-ops.js");

  const TOKENS_PER_FLUSH = 25;
  const FLUSHES = 5;

  for (const n of [1000, 20000]) {
    clearSessionRuntime();
    __resetTranscriptDeltaRebuildCount();
    state.session = buildLargeSession(n);
    state.realSession = state.session;
    state.socket = null;
    loadWindowFromSession(state, state.session);

    let offset = 0;
    for (let f = 0; f < FLUSHES; f += 1) {
      for (let t = 0; t < TOKENS_PER_FLUSH; t += 1) {
        const chunk = ` tok${f * TOKENS_PER_FLUSH + t}`;
        applyTranscriptDelta({
          thread_id: "thread-1",
          item_id: "item-0",
          turn_id: "turn-0",
          delta: chunk,
          delta_kind: "agent_text",
          text_offset: offset,
        });
        offset += chunk.length;
      }
      assert.equal(
        __readTranscriptDeltaRebuildCount(),
        f,
        `n=${n}: ${TOKENS_PER_FLUSH} deltas must not rebuild the transcript before their flush`
      );

      flushRemoteTranscriptRenderForTest();

      assert.equal(
        __readTranscriptDeltaRebuildCount(),
        f + 1,
        `n=${n}: exactly one rebuild per flush, regardless of transcript size`
      );
    }

    const streamed = state.session.transcript.find((entry) => entry.item_id === "item-0");
    const expectedTail = Array.from({ length: TOKENS_PER_FLUSH * FLUSHES }, (_, i) => ` tok${i}`).join("");
    assert.equal(streamed.text, expectedTail);
  }
});

test("with a loaded hydration window, per-token deltas never call find, findIndex, or map on the transcript array", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
    clearSessionRuntime,
  } = await import("./session-ops.js");

  for (const n of [1000, 20000]) {
    clearSessionRuntime();
    state.session = buildLargeSession(n);
    state.realSession = state.session;
    state.socket = null;
    loadWindowFromSession(state, state.session);

    // The window-loaded branch never replaces `.transcript` until settle, so
    // this one instrumented array reference sees every read/write the
    // per-token path makes for the whole streaming run below.
    const scans = instrumentArrayScans(state.realSession.transcript);

    let offset = 0;
    for (let t = 0; t < 25; t += 1) {
      const chunk = ` tok${t}`;
      applyTranscriptDelta({
        thread_id: "thread-1",
        item_id: "item-0",
        turn_id: "turn-0",
        delta: chunk,
        delta_kind: "agent_text",
        text_offset: offset,
      });
      offset += chunk.length;
    }

    assert.equal(
      scans.total(),
      0,
      `n=${n}: a windowed per-token delta must never call find/findIndex/map on the transcript array (saw ${JSON.stringify(scans.counts)})`
    );

    // Sanity: the run actually streamed real tokens, and settling still
    // produces the correct text — this is not vacuously true because nothing
    // happened.
    flushRemoteTranscriptRenderForTest();
    const streamed = state.session.transcript.find((entry) => entry.item_id === "item-0");
    const expectedTail = Array.from({ length: 25 }, (_, i) => ` tok${i}`).join("");
    assert.equal(streamed.text, expectedTail);
  }
});

test("with a loaded hydration window, the first delta for a brand-new item is O(1): no scan of the order array or the transcript array", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
    clearSessionRuntime,
  } = await import("./session-ops.js");

  for (const n of [1000, 20000]) {
    clearSessionRuntime();
    state.session = buildLargeSession(n);
    state.realSession = state.session;
    state.socket = null;
    loadWindowFromSession(state, state.session);

    // The other tests in this file only ever stream to "item-0", which is
    // already in the window before streaming starts — they never exercise a
    // delta's `!existing` branch (transcript-hydration-store.js). That branch
    // used to answer "is this id already ordered?" via `order.includes(itemId)`,
    // an O(window) scan on every brand-new item; the counters above would stay
    // flat at 20k rows while this one insert stayed O(n). Instrument the order
    // array (what that scan ran on) and the transcript array (the other thing
    // a per-token delta must never touch before settle).
    const orderScans = instrumentArrayScans(state.transcriptHydrationOrder);
    const transcriptScans = instrumentArrayScans(state.realSession.transcript);

    applyTranscriptDelta({
      thread_id: "thread-1",
      item_id: "item-new",
      turn_id: "turn-new",
      delta: "hello",
      delta_kind: "agent_text",
      text_offset: 0,
    });

    assert.equal(
      orderScans.total(),
      0,
      `n=${n}: a brand-new item's first delta must not scan the hydration order array (saw ${JSON.stringify(orderScans.counts)})`
    );
    assert.equal(
      transcriptScans.total(),
      0,
      `n=${n}: a brand-new item's first delta must not scan the transcript array (saw ${JSON.stringify(transcriptScans.counts)})`
    );

    flushRemoteTranscriptRenderForTest();
    const streamed = state.session.transcript.find((entry) => entry.item_id === "item-new");
    assert.equal(streamed?.text, "hello", `n=${n}: the new item's text must land in the rebuilt transcript after settle`);
  }
});

// The reconciler local and remote each run (resolveDeltaAppend,
// transcript-hydration-store.js) is shared code, but the surrounding routing
// — which session, which window, when to settle — is hand-duplicated on both
// sides. This is the test that would catch them drifting: the SAME delta
// sequence, including a re-delivered chunk (full overlap -> no-op), a gap
// (repair, not corruption), and a byte mismatch (repair, not corruption),
// driven through both surfaces' WINDOWED (O(1)) path, must land on identical
// text.
test("local and remote produce identical text for the same delta sequence, including a re-delivery, a gap, and a byte mismatch", async () => {
  activeBrowser || installBrowserStubs();

  const { createStreamController } = await import("../local/session/stream.js");
  const { settleTranscriptProjection } = await import("../local/transcript/store.js");
  const { createTranscriptFlushScheduler } = await import("../shared/transcript-flush-scheduler.js");
  const { state: remoteState } = await import("./state.js");
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
    clearSessionRuntime,
  } = await import("./session-ops.js");

  function windowedEntry() {
    return {
      item_id: "item-1",
      kind: "agent_text",
      status: "running",
      text: "",
      tool: null,
      turn_id: "turn-1",
      content_state: "full",
    };
  }

  // Local harness, mirrors frontend/local/session-stream.test.mjs's
  // makeController() — with the hydration window loaded, so this exercises
  // local's OWN O(1) branch too, not just its array fallback.
  const localState = {
    session: {
      active_thread_id: "thread-1",
      transcript: [windowedEntry()],
      transcript_revision: 0,
    },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map([["item-1", windowedEntry()]]),
    transcriptHydrationOrder: ["item-1"],
  };
  let localController;
  function renderSessionAndClearPendingFlush(_session) {
    localScheduler.cancel();
    settleTranscriptProjection(localState);
    return localState.session;
  }
  const localScheduler = createTranscriptFlushScheduler({
    render: () => {
      if (localState.session) renderSessionAndClearPendingFlush(localState.session);
    },
  });
  localController = createStreamController({
    applySessionSnapshot() {},
    cancelSessionPoll() {},
    cancelStreamReconnect() {},
    handleUnauthorized() {},
    logLine() {},
    renderSession: renderSessionAndClearPendingFlush,
    scheduleSessionPoll() {},
    scheduleStreamReconnect() {},
    seedDefaults() {},
    state: localState,
    transcriptFlushScheduler: localScheduler,
  });

  clearSessionRuntime();
  remoteState.session = {
    active_thread_id: "thread-1",
    transcript_revision: 0,
    transcript: [windowedEntry()],
  };
  remoteState.realSession = remoteState.session;
  remoteState.socket = null;
  loadWindowFromSession(remoteState, remoteState.session);

  // "Hello" -> duplicate "Hello" (no-op) -> " world" -> a gap ("!!!" far past
  // `have`) -> a byte mismatch ("XX" overlapping "ld" with different bytes)
  // -> "!". The gap and the mismatch must both be refused without touching
  // the text, on both surfaces, and the stream must still converge on
  // "Hello world!" once the final valid chunk lands.
  const steps = [
    { delta: "Hello", text_offset: 0 },
    { delta: "Hello", text_offset: 0 }, // full-overlap re-delivery
    { delta: " world", text_offset: 5 },
    { delta: "!!!", text_offset: 20 }, // gap: have=11, way short of 20
    { delta: "XX", text_offset: 9 }, // mismatch: chars [9,11) are "ld", not "XX"
    { delta: "!", text_offset: 11 },
  ];

  let revision = 0;
  for (const step of steps) {
    revision += 1;
    localController.applyLocalTranscriptEntryDelta({
      thread_id: "thread-1",
      item_id: "item-1",
      turn_id: "turn-1",
      delta: step.delta,
      revision,
      text_offset: step.text_offset,
    });
    applyTranscriptDelta({
      thread_id: "thread-1",
      item_id: "item-1",
      turn_id: "turn-1",
      delta: step.delta,
      delta_kind: "agent_text",
      revision,
      text_offset: step.text_offset,
    });
  }
  localScheduler.flushNow("test");
  flushRemoteTranscriptRenderForTest();

  const expectedText = "Hello world!";
  const localText = localState.session.transcript.find((entry) => entry.item_id === "item-1")?.text;
  const remoteText = remoteState.session.transcript.find((entry) => entry.item_id === "item-1")?.text;

  assert.equal(localText, expectedText, "local must refuse the gap and the mismatch, then converge");
  assert.equal(remoteText, expectedText, "remote must refuse the gap and the mismatch, then converge");
  assert.equal(localText, remoteText, "local and remote must render identical text for the same delta sequence");
});
