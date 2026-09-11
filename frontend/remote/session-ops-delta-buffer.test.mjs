// Reducer coverage for the remote delta hot path (frontend/remote/session-ops.js),
// which now adopts LOCAL's structure instead of the bespoke pending-append
// buffers this file used to cover: when the hydration window is loaded for a
// delta's own thread, the delta writes into it in O(1) (applyTranscriptDeltaToWindow)
// and projecting that back onto the rendered array is deferred to settle, once
// per flush, not once per token. When the window is NOT loaded, the array is
// rebuilt directly, synchronously, per delta — no buffering, matching local's
// own unhydrated fallback. These tests exercise the four offset outcomes
// (gap -> repair, byte mismatch -> repair, full overlap -> no-op, partial ->
// append only the missing suffix) against both paths.

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
  activeBrowser = {
    elements,
    runTimers() {
      while (pendingTimers.length) {
        const callback = pendingTimers.shift();
        if (callback) callback();
      }
    },
  };
  return activeBrowser;
}

function baseEntry() {
  return {
    item_id: "item-1",
    kind: "agent_text",
    status: "running",
    text: "Hello",
    turn_id: "turn-1",
    tool: null,
  };
}

async function freshRemoteSession(extra = {}) {
  const { state } = await import("./state.js");
  const { clearSessionRuntime } = await import("./session-ops.js");
  clearSessionRuntime();
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [baseEntry()],
    ...extra,
  };
  state.realSession = state.session;
  state.socket = null;
  return state;
}

// Same as freshRemoteSession, but with the hydration window loaded for
// thread-1 (mirroring every entry already in the transcript) — the
// precondition for the delta path's O(1) window-write branch.
async function freshRemoteSessionWithWindow(extra = {}) {
  const state = await freshRemoteSession(extra);
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map(
    state.session.transcript.map((entry) => [entry.item_id, { ...entry }])
  );
  state.transcriptHydrationOrder = state.session.transcript.map((entry) => entry.item_id);
  return state;
}

test("with a loaded hydration window, a partial offset append lands in the window immediately but the array lags until settle", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // The O(1) Map write lands immediately...
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello world");
  // ...but projecting it back onto the array is deferred to settle, once per
  // flush — this is the whole point of deferring the rebuild.
  assert.equal(state.session.transcript[0].text, "Hello", "array must lag until flush");

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
});

test("without a loaded hydration window, a partial offset append lands in the array immediately — no buffering, matching local's unhydrated fallback", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(state.session.transcript[0].text, "Hello world");
});

test("a duplicate re-delivery against the buffered view is a no-op", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(
    state.session.transcript[0].text,
    "Hello world",
    "the duplicate must be recognized against baseText + buffered appendText, not double-applied"
  );
});

// P2 (review): the four offset outcomes were only exercised against the
// array-fallback path (freshRemoteSession); the loaded-window O(1) path
// (freshRemoteSessionWithWindow) needs its own coverage for each outcome too
// — the two paths read/write different state, so a regression in one is
// invisible to a test against the other.
test("with a loaded hydration window, a duplicate re-delivery is a no-op", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  assert.equal(
    state.transcriptHydrationEntries.get("item-1").text,
    "Hello world",
    "the duplicate must be recognized against the window's own cached text, not double-applied"
  );
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
});

// A run of rejected deltas for the same item (duplicates, then a genuine
// gap) must neither corrupt the array nor let a later, unrelated flush count
// them as a rebuild — each is read-and-decided fresh against the CURRENT
// array, synchronously, with no cross-delta caching to go stale.
test("repeated non-appending deltas for the same item leave the array untouched and do not count as a rebuild", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const {
    applyTranscriptDelta,
    flushRemoteTranscriptRenderForTest,
    __readTranscriptDeltaRebuildCount,
    __resetTranscriptDeltaRebuildCount,
  } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;
  __resetTranscriptDeltaRebuildCount();

  // Duplicate re-delivery of the full baseText, three times in a row — none
  // of these append anything.
  for (let i = 0; i < 3; i += 1) {
    applyTranscriptDelta({
      thread_id: "thread-1",
      base_revision: 5,
      revision: 5,
      item_id: "item-1",
      turn_id: "turn-1",
      delta: "Hello",
      delta_kind: "agent_text",
      text_offset: 0,
    });
  }

  // A genuine gap, repeated — each rejected on its own, against the
  // (unchanged) array.
  for (let i = 0; i < 2; i += 1) {
    applyTranscriptDelta({
      thread_id: "thread-1",
      base_revision: 5,
      revision: 6,
      item_id: "item-1",
      turn_id: "turn-1",
      delta: "!!",
      delta_kind: "agent_text",
      text_offset: 20,
    });
  }
  assert.equal(window.__transcriptGapRepairCount, 2, "each gap delta still schedules its own repair");
  assert.equal(state.session.transcript[0].text, "Hello", "no rejected delta may have touched the array");

  flushRemoteTranscriptRenderForTest();
  assert.equal(__readTranscriptDeltaRebuildCount(), 0, "nothing appended, so a flush must not count as a rebuild");
  assert.equal(state.session.transcript[0].text, "Hello");
  delete window.__transcriptGapRepairCount;
});

// Caching a lookup on every delta (the P1 fix above) only stays correct if a
// cached baseEntry never outlives the array it was read from. Without that,
// a non-appending delta (rejected, but still cached per the fix above)
// followed by the transcript array being replaced out of band would leave a
// stale baseEntry in the buffer for the next delta to wrongly compare
// against — exactly the failure this covers.
test("a cached lookup from a rejected delta does not survive the session's transcript array being replaced", async () => {
  activeBrowser || installBrowserStubs();
  const { state } = await import("./state.js");
  const { clearSessionRuntime, applyTranscriptDelta, flushRemoteTranscriptRenderForTest } =
    await import("./session-ops.js");
  clearSessionRuntime();

  // First session: a duplicate delta caches (but never dirties) a lookup for
  // item-1 against THIS array.
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 5,
    transcript: [{ ...baseEntry(), text: "Hello world" }],
  };
  state.realSession = state.session;
  state.socket = null;
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 5,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // A brand new session object replaces the array out of band — the shape
  // every test in this file that skips clearSessionRuntime relies on being
  // safe, and the shape a real client hits on a fresh thread switch too.
  state.session = {
    active_thread_id: "thread-1",
    transcript_revision: 6,
    transcript: [{ ...baseEntry(), text: "Hello wor" }],
  };
  state.realSession = state.session;

  // Have 9 chars in the NEW array; only "ld" is missing. If the stale cached
  // baseEntry ("Hello world", 11 chars) were trusted instead, this would be
  // wrongly read as a duplicate and dropped.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");
});

test("a byte mismatch against the buffered view schedules repair instead of corrupting text", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // Overlaps the buffered " wor" (offset 6..9 is "or ") with different bytes.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "XX",
    delta_kind: "agent_text",
    text_offset: 6,
  });

  assert.equal(window.__transcriptGapRepairCount, 1, "the mismatch must be caught against baseText + buffer");
  flushRemoteTranscriptRenderForTest();
  assert.equal(
    state.session.transcript[0].text,
    "Hello wor",
    "the buffered (pre-mismatch) text must survive — the mismatched delta itself must not apply"
  );
  delete window.__transcriptGapRepairCount;
});

test("with a loaded hydration window, a byte mismatch schedules repair instead of corrupting text", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // Overlaps the window's cached " wor" (offset 6..9 is "or ") with different bytes.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "XX",
    delta_kind: "agent_text",
    text_offset: 6,
  });

  assert.equal(window.__transcriptGapRepairCount, 1, "the mismatch must be caught against the window's own cached text");
  assert.equal(
    state.transcriptHydrationEntries.get("item-1").text,
    "Hello wor",
    "the window's pre-mismatch text must survive — the mismatched delta itself must not apply"
  );
  // P1 (review): invalidate when the gap/mismatch is DETECTED, not only once
  // the repair fetch succeeds — a failed or exhausted retry must not leave
  // this trusted `full` forever (.sealwire/PLAN.md, "Invalidate; do not
  // write"). This inverts a prior assertion that codified the fail-open bug:
  // scheduleTranscriptGapRepair now downgrades the window synchronously, at
  // schedule time, rather than only in repairActiveTranscriptTail's success path.
  assert.equal(
    state.transcriptHydrationEntries.get("item-1").content_state,
    "preview",
    "a detected mismatch must downgrade content_state at once, so hydration can still refetch even if repair fails"
  );
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello wor");
  delete window.__transcriptGapRepairCount;
});

test("a gap against the buffered view schedules repair instead of corrupting text", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // have = 9 (buffered); offset 15 is beyond it even accounting for the buffer.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "ld!",
    delta_kind: "agent_text",
    text_offset: 15,
  });

  assert.equal(window.__transcriptGapRepairCount, 1);
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello wor");
  delete window.__transcriptGapRepairCount;
});

test("with a loaded hydration window, a gap schedules repair instead of corrupting text", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // have = 9 (window's cached text); offset 15 is beyond it.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "ld!",
    delta_kind: "agent_text",
    text_offset: 15,
  });

  assert.equal(window.__transcriptGapRepairCount, 1);
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Hello wor");
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello wor");
  delete window.__transcriptGapRepairCount;
});

test("a gap detected while appends are already buffered is computed from the buffered text, not the stale array", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");
  window.__transcriptGapRepairCount = 0;

  // Buffers " wor" without flushing — the array still only holds "Hello" (5
  // chars), but the effective (buffered) length is 9.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // offset 7 is a GAP against the stale array (have=5) but NOT against the
  // buffered view (have=9) — it is fully covered re-delivery ("or" at 7..9).
  // If the gap check read the stale array instead of baseText+appendText, it
  // would wrongly schedule a repair here.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "or",
    delta_kind: "agent_text",
    text_offset: 7,
  });
  assert.equal(
    window.__transcriptGapRepairCount,
    0,
    "re-delivery fully covered by the buffer must not be mistaken for a gap against the stale array"
  );

  // A genuinely out-of-reach offset (target far past the buffered have=9)
  // must still be recognized as a real gap, logged with the BUFFERED have.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 7,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "!!!",
    delta_kind: "agent_text",
    text_offset: 20,
  });
  assert.equal(window.__transcriptGapRepairCount, 1);
  assert.match(
    state.clientLogs[0],
    /have=9\b/,
    "the gap detail must report the buffered have (9), not the stale array's (5)"
  );

  // The earlier buffered append must not have been discarded by the gap.
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello wor");
  delete window.__transcriptGapRepairCount;
});

test("re-delivery of a chunk spanning a flush boundary is a duplicate against the flushed array", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  // Flush clears the buffer and applies " world" to the array — the item's
  // baseEntry cache is gone, so the next delta for it must re-scan the array.
  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world");

  // Spans the boundary: chars 3..11 straddle what was buffered ("world") and
  // what was already in the base array ("lo ").
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "lo world",
    delta_kind: "agent_text",
    text_offset: 3,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(
    state.session.transcript[0].text,
    "Hello world",
    "the re-delivered chunk must be recognized against the freshly-flushed array, not double-appended"
  );
});

test("appends only the missing suffix when a partial re-delivery spans baseText and a currently-buffered appendText", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSession();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  // Buffers " wor" without flushing — have is 9 (base "Hello" + buffered
  // " wor"), but the array still only holds "Hello".
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  // Starts at offset 3 — inside baseText ("Hel|lo") — and its 9 chars reach
  // to offset 12, past have=9. The overlap (offset 3..9) therefore spans
  // BOTH baseText (3..5) and the still-unflushed buffered appendText (5..9);
  // only the missing tail past have ("ld!") must be appended.
  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 6,
    revision: 6,
    item_id: "item-1",
    turn_id: "turn-1",
    delta: "lo world!",
    delta_kind: "agent_text",
    text_offset: 3,
  });

  flushRemoteTranscriptRenderForTest();
  assert.equal(state.session.transcript[0].text, "Hello world!");
});

test("a flush with nothing buffered does not rebuild the array", async () => {
  activeBrowser || installBrowserStubs();
  await freshRemoteSession();
  const {
    flushRemoteTranscriptRenderForTest,
    __readTranscriptDeltaRebuildCount,
    __resetTranscriptDeltaRebuildCount,
  } = await import("./session-ops.js");

  __resetTranscriptDeltaRebuildCount();
  flushRemoteTranscriptRenderForTest();
  assert.equal(__readTranscriptDeltaRebuildCount(), 0);
});

// The O(1)-per-flush claim (sweep 1k/20k rows, assert the rebuild count
// stays flat) and the local/remote text-parity proof both moved to
// frontend/remote/session-ops-delta-perf.test.mjs, alongside the new
// find/findIndex/map instrumentation — this file stays scoped to reducer
// correctness (the four offset outcomes) and metadata preservation below.

// REVIEW P2: a loaded-window delta writes through applyTranscriptDeltaToWindow,
// which (unlike the retired buffers and the no-window array fallback) never
// read or wrote entry_seq — so a delta carrying it was silently dropping that
// metadata once the window projected back onto the array.
test("with a loaded hydration window, a delta's entry_seq survives into the projected array entry", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    entry_seq: 7,
    delta: " world",
    delta_kind: "agent_text",
    text_offset: 5,
  });

  flushRemoteTranscriptRenderForTest();

  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(
    state.session.transcript[0].entry_seq,
    7,
    "entry_seq must survive the window write, the same way the array fallback already preserves it"
  );
});

// The first VALID entry_seq wins and later deltas for the same item must not
// clobber it — mirrors the array fallback's own
// `Number.isSafeInteger(entry_seq) && !Number.isSafeInteger(entry.entry_seq)` rule.
test("with a loaded hydration window, the first valid entry_seq for an item is retained across later deltas", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    entry_seq: 3,
    delta: " wor",
    delta_kind: "agent_text",
    text_offset: 5,
  });
  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-1",
    turn_id: "turn-1",
    entry_seq: 99,
    delta: "ld",
    delta_kind: "agent_text",
    text_offset: 9,
  });

  flushRemoteTranscriptRenderForTest();

  assert.equal(state.session.transcript[0].text, "Hello world");
  assert.equal(state.session.transcript[0].entry_seq, 3, "the first valid entry_seq must not be overwritten by a later one");
});

// A brand-new item (not yet in the window) must also record its entry_seq —
// mirrors the array fallback's new-entry branch.
test("with a loaded hydration window, a brand-new item's entry_seq is recorded", async () => {
  activeBrowser || installBrowserStubs();
  const state = await freshRemoteSessionWithWindow();
  const { applyTranscriptDelta, flushRemoteTranscriptRenderForTest } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    item_id: "item-new",
    turn_id: "turn-new",
    entry_seq: 42,
    delta: "a brand new message",
    delta_kind: "agent_text",
    text_offset: 0,
  });

  flushRemoteTranscriptRenderForTest();

  const created = state.session.transcript.find((entry) => entry.item_id === "item-new");
  assert.equal(created?.text, "a brand new message");
  assert.equal(created?.entry_seq, 42);
});

// ---------------------------------------------------------------------------
// Birth numbers on the remote delta path. The window writer places rows by
// order_seq, but remote hand-builds the payload it hands over, so the number has
// to actually be forwarded — dropping it leaves every remote-created row
// unnumbered and the whole window ineligible for the keyed merge.
// ---------------------------------------------------------------------------

const ORDER_STEP = 1 << 20;

async function keyedRemoteWindow() {
  const state = await freshRemoteSessionWithWindow();
  state.transcriptHydrationEntries.set("item-1", {
    ...state.transcriptHydrationEntries.get("item-1"),
    order_seq: 0,
  });
  return state;
}

test("a remote delta forwards the row's birth number into the window", async () => {
  activeBrowser || installBrowserStubs();
  const state = await keyedRemoteWindow();
  const { applyTranscriptDelta } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-2",
    turn_id: "turn-1",
    delta: "second row",
    delta_kind: "agent_text",
    text_offset: 0,
    order_seq: ORDER_STEP,
  });

  assert.equal(
    state.transcriptHydrationEntries.get("item-2").order_seq,
    ORDER_STEP,
    "remote must not strip order_seq while relaying the delta to the window"
  );
});

test("a remote delta for a mid-numbered row lands in its slot, not at the tail", async () => {
  activeBrowser || installBrowserStubs();
  const state = await keyedRemoteWindow();
  state.transcriptHydrationEntries.set("item-3", {
    item_id: "item-3",
    kind: "agent_text",
    text: "later row",
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    order_seq: 2 * ORDER_STEP,
  });
  state.transcriptHydrationOrder = ["item-1", "item-3"];
  const { applyTranscriptDelta } = await import("./session-ops.js");

  applyTranscriptDelta({
    thread_id: "thread-1",
    base_revision: 5,
    revision: 6,
    item_id: "item-2",
    turn_id: "turn-1",
    delta: "born earlier, streamed later",
    delta_kind: "agent_text",
    text_offset: 0,
    order_seq: ORDER_STEP,
  });

  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["item-1", "item-2", "item-3"],
    "arrival order must not outrank the server's numbering on the remote surface either"
  );
});

// ---------------------------------------------------------------------------
// The tail repair writes straight into the hydration window. It is authoritative
// for CONTENT, never for where a row already sits — rewriting a birth key here
// moves nothing and clears nothing, so the cached keyed proof would keep
// claiming "numbered and in order" over a window that no longer is.
//
// INVARIANT HARDENING, not a reachable production bug: repairActiveTranscriptTail
// rejects a page from another generation before this runs, and Rust omits
// `withdrawn` when false, so neither conflicting input is on the wire today. The
// inputs below are constructed to violate the invariant directly.
// ---------------------------------------------------------------------------

test("a conflicting or stale repaired copy cannot move, renumber, or resurrect a row", async () => {
  activeBrowser || installBrowserStubs();
  const state = await keyedRemoteWindow();
  state.transcriptHydrationEntries.set("item-2", {
    item_id: "item-2",
    kind: "agent_text",
    text: "held",
    status: "completed",
    order_seq: ORDER_STEP,
    withdrawn: true,
  });
  state.transcriptHydrationOrder = ["item-1", "item-2"];
  state.transcriptHydrationKeyed = true;
  const { __syncTranscriptWindowWithRepairedEntriesForTest } = await import("./session-ops.js");

  __syncTranscriptWindowWithRepairedEntriesForTest("thread-1", [
    // Constructed to violate the invariant: a conflicting number, and an
    // explicit withdrawn:false of the kind the wire does not currently produce.
    { item_id: "item-2", text: "repaired body", order_seq: 99 * ORDER_STEP, withdrawn: false },
  ]);

  const repaired = state.transcriptHydrationEntries.get("item-2");
  assert.equal(repaired.order_seq, ORDER_STEP, "the held birth key wins");
  assert.equal(repaired.withdrawn, true, "a stale withdrawn:false must not resurrect the row");
  assert.equal(repaired.text, "repaired body", "content still repairs");
  assert.deepEqual(state.transcriptHydrationOrder, ["item-1", "item-2"], "order untouched");
  assert.equal(state.transcriptHydrationKeyed, true, "and the proof still holds");
});

// ---------------------------------------------------------------------------
// B5: the remote view-only generation transition, driven directly.
//
// The projection SPREADS the incoming snapshot and injects the previously
// rendered entries, so without the fence the old run's ids would be handed the
// new run's generation and nothing downstream could tell. The pin must be
// dropped and refetched, never relabelled.
//
// The pin is seeded through a test hook because setting it the real way means
// viewRemoteThread, which fetches over the broker/E2EE stack; the transition
// under test is the real applySessionSnapshot path.
// ---------------------------------------------------------------------------

function genSnapshot(generation, threadId, entries) {
  return {
    active_thread_id: threadId,
    transcript_generation: generation,
    transcript_revision: 7,
    transcript: entries,
    thread_activity: [],
  };
}

async function pinnedUnder(generation) {
  const state = await freshRemoteSession();
  const ops = await import("./session-ops.js");
  state.session = { ...genSnapshot(generation, "viewed", [baseEntry()]), view_only: true };
  state.realSession = genSnapshot(generation, "live-thread", [baseEntry()]);
  ops.__setViewOnlyPinForTest("viewed", generation);
  return { state, ops };
}

test("a gen-B snapshot drops the gen-A pin instead of rewrapping its entries", async () => {
  activeBrowser || installBrowserStubs();
  const { state, ops } = await pinnedUnder("gen-a");

  ops.applySessionSnapshot(
    genSnapshot("gen-b", "live-thread", [
      { ...baseEntry(), item_id: "gen-b-item", text: "new run" },
    ])
  );

  const pin = ops.__readViewOnlyPinForTest();
  assert.equal(pin.threadId, null, "the gen-a pin is released, not relabelled");
  assert.equal(pin.generation, "gen-b", "and the new run is recorded");
  const ids = (state.session.transcript || []).map((entry) => entry.item_id);
  assert.deepEqual(ids, ["gen-b-item"], "no gen-a id survives into the gen-b render");
  assert.equal(new Set(ids).size, ids.length, "and nothing is duplicated");
});

test("the transition happens once and does not loop on later gen-B snapshots", async () => {
  activeBrowser || installBrowserStubs();
  const { state, ops } = await pinnedUnder("gen-a");

  ops.applySessionSnapshot(genSnapshot("gen-b", "live-thread", [baseEntry()]));
  const afterFirst = ops.__readViewOnlyPinForTest();

  // Two more snapshots under the SAME run must be ordinary renders. A fence that
  // re-fired here would refetch on every snapshot for the rest of the session.
  ops.applySessionSnapshot(genSnapshot("gen-b", "live-thread", [baseEntry()]));
  ops.applySessionSnapshot(genSnapshot("gen-b", "live-thread", [baseEntry()]));

  assert.deepEqual(ops.__readViewOnlyPinForTest(), afterFirst, "converged, no repeated reset");
  assert.equal(state.session.transcript.length, 1, "and the render stays stable");
});

test("the one-sided-empty boundary transitions in both directions", async () => {
  // An old relay stamps nothing and a new one does, so "" <-> "gen-x" is a real
  // upgrade/downgrade — the same rename, and it must not be read as "no change".
  activeBrowser || installBrowserStubs();

  const upgrading = await pinnedUnder("");
  upgrading.ops.applySessionSnapshot(genSnapshot("gen-b", "live-thread", [baseEntry()]));
  assert.equal(upgrading.ops.__readViewOnlyPinForTest().threadId, null, "empty -> stamped releases");

  const downgrading = await pinnedUnder("gen-a");
  downgrading.ops.applySessionSnapshot(genSnapshot("", "live-thread", [baseEntry()]));
  assert.equal(downgrading.ops.__readViewOnlyPinForTest().threadId, null, "stamped -> empty releases");
});

test("a same-generation snapshot keeps the pin", async () => {
  activeBrowser || installBrowserStubs();
  const { ops } = await pinnedUnder("gen-a");

  ops.applySessionSnapshot(genSnapshot("gen-a", "live-thread", [baseEntry()]));

  assert.equal(ops.__readViewOnlyPinForTest().threadId, "viewed", "no run change, no release");
});
