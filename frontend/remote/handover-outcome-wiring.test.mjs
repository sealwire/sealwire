// The phone's wiring, exercised rather than matched.
//
// The structural guards next door pin the SHAPE of the wiring, which is the only way to
// check a module that needs a browser to evaluate. This is the other half: the handler
// remote-runtime really builds, called with a real feed, landing in the real per-thread
// composer-error store. Every join in this chain has dropped the payload at least once
// while its own unit test stayed green.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
if (!global.crypto) global.crypto = webcrypto;

const { createRemoteAppHandlers } = await import("./remote-runtime.js");
const { state } = await import("./state.js");

const failure = (id, source, error) => ({
  id,
  source_thread_id: source,
  target_thread_id: `${id}-target`,
  status: "failed",
  error,
});

test("the phone's handler writes a handover failure onto its own thread's composer", () => {
  const handlers = createRemoteAppHandlers();
  assert.equal(typeof handlers.onHandoverOutcomes, "function");

  // The person handed the work over and moved on — the ordinary case.
  handlers.onHandoverOutcomes(
    [failure("handover-a1", "thread-a", "that agent is busy right now")],
    "thread-b"
  );

  assert.match(
    state.composerErrors["thread-a"] || "",
    /busy right now/,
    "the failure has to reach the store the composer reads, keyed by the SOURCE thread"
  );
  assert.equal(
    state.composerErrors["thread-b"],
    undefined,
    "and not the thread that happens to be on screen"
  );
});

test("the handler is a no-op for a feed with nothing failed on it", () => {
  const handlers = createRemoteAppHandlers();
  const before = { ...state.composerErrors };

  handlers.onHandoverOutcomes([], "thread-a");
  handlers.onHandoverOutcomes(
    [{ ...failure("handover-w", "thread-w", null), status: "working" }],
    "thread-w"
  );

  assert.deepEqual({ ...state.composerErrors }, before);
});
