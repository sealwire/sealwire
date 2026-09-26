import test from "node:test";
import assert from "node:assert/strict";

// lifecycle.js imports dom.js, which queries the document at import time.
const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    const heldText = { textContent: "" };
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      heldText,
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      querySelector: (sel) => (sel === ".composer-held-text" ? heldText : null),
      querySelectorAll: () => [],
    });
  }
  return nodes.get(selector);
}

globalThis.document = {
  querySelector: fakeNode,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: () => fakeNode("created"),
  get body() {
    return fakeNode("body");
  },
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
  location: { origin: "http://relay.test" },
};

const { createLifecycleController } = await import("./lifecycle.js");
const { createViewOnlyRefreshOps } = await import("../view-only-refresh-ops.js");
const { createTranscriptController } = await import("./transcript.js");
const { createRelayQueryClient } = await import("../../shared/query-client.js");

const LIVE = "thread-live";
const VIEWED = "thread-viewed";

function syncScheduler(render) {
  return {
    queue: render,
    note() {},
    flushNow: render,
    cancel() {},
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

test("a viewed thread's page sent before a confirmed model change does not bring the old model back", async () => {
  const liveSession = {
    active_thread_id: LIVE,
    transcript: [],
    transcript_revision: 1,
    thread_activity: [],
    model: "live-model",
  };
  const state = { deviceId: "device-1", session: liveSession, viewOnlyThread: null, viewOnlyGeneration: 0 };
  const held = [];
  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: (threadId) => new Promise((resolve) => held.push({ threadId, resolve })),
    renderSession: () => {},
  });
  const controller = createLifecycleController({
    state,
    apiFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: liveSession }),
    }),
    logLine: () => {},
    renderSession: () => {},
    transcriptFlushScheduler: syncScheduler(() => {}),
    canCurrentDeviceWrite: () => true,
    seedDefaults: () => {},
    setSelectedCwd: () => {},
    setThreadRoute: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    renderAuthRequiredState: () => {},
    runViewTransition: (fn) => fn(),
    setStartControlsBusy: () => {},
    liveElement: () => null,
    isViewingConversation: () => true,
    queryClient: null,
  });
  const pageWithModel = (model) => ({
    thread_id: VIEWED,
    revision: 2,
    entries: [{ item_id: "v-1", kind: "agent_text", text: "viewed", status: "completed" }],
    prev_cursor: null,
    thread_state: { model, settings_writable: true },
  });

  const firstLoad = ops.loadViewOnlyTranscript(VIEWED);
  held.shift().resolve(pageWithModel("old-model"));
  await firstLoad;
  assert.equal(state.viewOnlyThread?.settings?.model, "old-model", "precondition");

  // A refresh goes out, then the user picks a new model and the relay confirms it.
  const refresh = ops.loadViewOnlyTranscript(VIEWED);
  await controller.updateSessionSettings({ model: "new-model" });
  assert.equal(state.viewOnlyThread?.settings?.model, "new-model", "precondition: the pick shows at once");

  held.shift().resolve(pageWithModel("old-model"));
  await refresh;

  assert.equal(state.viewOnlyThread?.settings?.model, "new-model", "a read sent before the change must not undo it");

  // One sent after it is current again, e.g. a model changed from another device.
  const later = ops.loadViewOnlyTranscript(VIEWED);
  held.shift().resolve(pageWithModel("model-from-elsewhere"));
  await later;
  assert.equal(state.viewOnlyThread?.settings?.model, "model-from-elsewhere");
});

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
}

// The production page fetch (query cache included) behind a relay whose page answers the test releases.
function buildRealFetchHarness() {
  const liveSession = {
    active_thread_id: LIVE,
    transcript: [],
    transcript_revision: 1,
    thread_activity: [],
    model: "live-model",
  };
  const state = { deviceId: "device-1", session: liveSession, viewOnlyThread: null, viewOnlyGeneration: 0 };
  const heldPages = [];
  const apiFetch = async (url) => {
    if (String(url).includes("/api/session/settings")) {
      return jsonResponse(liveSession);
    }
    return new Promise((resolve) => heldPages.push(resolve));
  };
  const queryClient = createRelayQueryClient();
  const transcriptController = createTranscriptController({
    state,
    apiFetch,
    queryClient,
    logLine: () => {},
    renderSession: () => {},
    isViewingConversation: () => true,
    loadSession: async () => {},
  });
  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: transcriptController.fetchTranscriptPage,
    renderSession: () => {},
  });
  const lifecycle = createLifecycleController({
    state,
    apiFetch,
    logLine: () => {},
    renderSession: () => {},
    transcriptFlushScheduler: syncScheduler(() => {}),
    canCurrentDeviceWrite: () => true,
    seedDefaults: () => {},
    setSelectedCwd: () => {},
    setThreadRoute: () => {},
    renderOverviewState: () => {},
    renderSessionUnavailable: () => {},
    renderThreadListMessage: () => {},
    renderThreads: () => {},
    renderAuthRequiredState: () => {},
    runViewTransition: (fn) => fn(),
    setStartControlsBusy: () => {},
    liveElement: () => null,
    isViewingConversation: () => true,
    queryClient,
  });
  return {
    state,
    ops,
    lifecycle,
    heldPages,
    answerPage(threadState) {
      heldPages.shift()(jsonResponse({
        thread_id: VIEWED,
        revision: 2,
        entries: [{ item_id: "v-1", kind: "agent_text", text: "viewed", status: "completed" }],
        prev_cursor: null,
        thread_state: { settings_writable: true, ...threadState },
      }));
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a read that shares a request sent before a confirmed model change does not bring the old model back", async () => {
  const h = buildRealFetchHarness();
  const firstLoad = h.ops.loadViewOnlyTranscript(VIEWED);
  await settle();
  h.answerPage({ model: "old-model" });
  await firstLoad;
  assert.equal(h.state.viewOnlyThread?.settings?.model, "old-model", "precondition");

  const before = h.ops.loadViewOnlyTranscript(VIEWED);
  await settle();
  await h.lifecycle.updateSessionSettings({ model: "new-model" });
  // Asked after the change, but answered by the request that went out before it.
  const after = h.ops.loadViewOnlyTranscript(VIEWED);
  await settle();
  assert.equal(h.heldPages.length, 1, "precondition: the second read shares the first request");

  h.answerPage({ model: "old-model" });
  await Promise.all([before, after]);

  assert.equal(h.state.viewOnlyThread?.settings?.model, "new-model");
});

test("a confirmed model change does not hold back another setting changed elsewhere", async () => {
  const h = buildRealFetchHarness();
  const firstLoad = h.ops.loadViewOnlyTranscript(VIEWED);
  await settle();
  h.answerPage({ model: "old-model", reasoning_effort: "low" });
  await firstLoad;

  const refresh = h.ops.loadViewOnlyTranscript(VIEWED);
  await settle();
  await h.lifecycle.updateSessionSettings({ model: "new-model" });
  // This read predates the model change, but another device raised the effort before it.
  h.answerPage({ model: "old-model", reasoning_effort: "high" });
  await refresh;

  assert.equal(h.state.viewOnlyThread?.settings?.model, "new-model");
  assert.equal(h.state.viewOnlyThread?.settings?.reasoning_effort, "high");
});
