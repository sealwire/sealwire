// `sendMessage` takes its target thread as an argument precisely because the user can
// navigate while the request is in flight — and it is also the send path the
// Orchestrator's own composer uses. Blanking the shared textarea from in here is wrong
// on both counts: it clears whichever thread's draft happens to be on screen when the
// response lands, and an Orchestrator send wipes the main composer of an unrelated
// session. Which draft a success consumed is the CALLER's to decide; it is the only
// side that knows the scope the submit started from.
//
// Same fake-document shape as send-error.test.mjs: lifecycle.js transitively imports
// dom.js, which queries the document at import time.
import test from "node:test";
import assert from "node:assert/strict";

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
};

const { createLifecycleController } = await import("./lifecycle.js");

// This file is about which draft a send consumes, not the flush scheduler, so renders
// fire synchronously rather than stepping a fake clock.
function createSyncTranscriptFlushScheduler(render) {
  return {
    queue: render,
    note() {},
    flushNow: render,
    cancel() {},
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

const logged = [];
function buildController() {
  const state = {
    deviceId: "device-1",
    session: {
      active_thread_id: "thread-1",
      available_models: [],
      model: "gpt-5.5",
      provider: "codex",
      reasoning_effort: "low",
    },
  };
  return createLifecycleController({
    state,
    apiFetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { active_thread_id: "thread-1", transcript: [] } }),
    }),
    logLine: (line) => logged.push(line),
    renderSession: () => {},
    transcriptFlushScheduler: createSyncTranscriptFlushScheduler(() => {}),
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
}

test("a successful send leaves the shared composer box alone", async () => {
  const controller = buildController();
  const input = fakeNode("#message-input");
  input.value = "a sentence the user is still typing somewhere else";

  const sent = await controller.sendMessage("hello", "thread-1");

  assert.equal(sent, true, `the send itself must still succeed: ${logged.join(" | ")}`);
  assert.equal(
    input.value,
    "a sentence the user is still typing somewhere else",
    "clearing the one textarea from in here throws away whichever thread's draft is on screen"
  );
});
