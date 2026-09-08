// "Sending answer…" has to appear WHILE the answer is being sent.
//
// The controller marks the request in flight and then renders nothing until the
// request settles, so the card stayed enabled and silent for the whole round
// trip — long enough on a slow link to tap a second option and send two
// competing answers for one question.
//
// dom.js queries the document at import time, so the stubs mirror
// send-error.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

const nodes = new Map();
function fakeNode(selector) {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      selector,
      value: "",
      disabled: false,
      hidden: true,
      textContent: "",
      dataset: {},
      style: {},
      classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      querySelector: () => null,
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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  navigator: { userAgent: "node" },
};

const { createPairingController } = await import("./pairing.js");
const { createLocalUiStore } = await import("../ui-store.js");

test("the card is told an answer is on its way, not only that it arrived", async () => {
  const localUiStore = createLocalUiStore();
  const state = { deviceId: "device-1", session: { active_thread_id: "thread-1" }, localUiStore };
  // What the surface would have painted, each time it was asked to paint.
  const paintedInFlight = [];
  let release = null;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  const controller = createPairingController({
    state,
    shortId: (id) => id,
    logLine: () => {},
    liveElement: () => null,
    renderSession: () => {
      paintedInFlight.push(new Set(localUiStore.getState().askUserSubmittingRequestIds));
    },
    applySessionSnapshot: () => {},
    loadSession: async () => {},
    apiFetch: async () => {
      await inFlight;
      return { ok: true, json: async () => ({ ok: true, data: { message: "Answer sent." } }) };
    },
  });

  const submission = controller.submitAskUserQuestionAnswer("ask:1", { q: "A" });
  await Promise.resolve();

  assert.ok(
    paintedInFlight.some((ids) => ids.has("ask:1")),
    "the reader must see the answer leave: a render has to happen while it is in flight"
  );

  release();
  await submission;
  assert.equal(
    localUiStore.getState().askUserSubmittingRequestIds.size,
    0,
    "and the card is released once it lands"
  );
});

test("a second send for the same question while the first is in flight is ignored", async () => {
  const localUiStore = createLocalUiStore();
  const state = { deviceId: "device-1", session: { active_thread_id: "thread-1" }, localUiStore };
  let posts = 0;
  let release = null;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  const controller = createPairingController({
    state,
    shortId: (id) => id,
    logLine: () => {},
    liveElement: () => null,
    renderSession: () => {},
    applySessionSnapshot: () => {},
    loadSession: async () => {},
    apiFetch: async () => {
      posts += 1;
      await inFlight;
      return { ok: true, json: async () => ({ ok: true, data: { message: "Answer sent." } }) };
    },
  });

  // Two taps inside one tick, or a click the disabled state has not painted over
  // yet: both used to POST, and whichever came back first cleared the only
  // in-flight marker — re-enabling the card while the other was still going.
  const first = controller.submitAskUserQuestionAnswer("ask:x", { q: "A" });
  const second = controller.submitAskUserQuestionAnswer("ask:x", { q: "B" });
  await Promise.resolve();

  assert.equal(posts, 1, "one question, one answer");

  release();
  await Promise.all([first, second]);
  assert.equal(localUiStore.getState().askUserSubmittingRequestIds.size, 0);
});
