// The review card's buttons reach the desktop controller by name, so each has to be
// one the controller actually hands out.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The one element `dom.js` reaches into as the module loads.
const dom = new JSDOM(
  '<!doctype html><html><body><form id="connection-form"></form></body></html>',
  { url: "http://localhost/" }
);
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;

const { createSessionController } = await import("./session-controller.js");
const { dispatchReviewAction } = await import("../shared/review-card.js");
const { dispatchDelegateAction } = await import("../shared/delegate-card.js");

function controllerForTest() {
  const noop = () => {};
  return createSessionController({
    state: {},
    apiFetch: noop,
    shortId: (value) => value,
    logLine: noop,
    seedDefaults: noop,
    setSelectedCwd: noop,
    setThreadRoute: noop,
    canCurrentDeviceWrite: () => true,
    renderSession: noop,
    renderOverviewState: noop,
    renderSessionUnavailable: noop,
    renderThreadListMessage: noop,
    renderThreads: noop,
    renderAuthRequiredState: noop,
    runViewTransition: (run) => run(),
    handleUnauthorized: noop,
  });
}

test("every review card button has a controller method behind it", () => {
  const controller = controllerForTest();
  const called = [];
  const handlers = {
    stop: () => called.push(typeof controller.resolveReview),
    accept: () => called.push(typeof controller.acceptReview),
    rerun: () => called.push(typeof controller.requestReview),
  };
  for (const action of ["stop", "accept", "rerun"]) {
    dispatchReviewAction({ action, reviewId: "r", reviewerProvider: "codex" }, handlers);
  }
  assert.deepEqual(called, ["function", "function", "function"]);
});

test("the delegate card's Cancel has a controller method behind it", () => {
  const controller = controllerForTest();
  const called = [];
  dispatchDelegateAction(
    { action: "cancel", threadId: "t" },
    { cancel: () => called.push(typeof controller.stopActiveTurn) }
  );
  assert.deepEqual(called, ["function"]);
});
