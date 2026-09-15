// `handlersRef.current.onX?.(…)` fails SILENTLY when `onX` was never provided — the
// optional chain is indistinguishable from a handler that ran and did nothing. That is
// how the phone ended up with a composer-error channel nobody had connected.
//
// So: every name react-app reaches for must exist on the object remote-runtime builds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

// remote-runtime touches the browser at import time; this only has to be enough for
// the module to load and hand back its handler map.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
if (!global.crypto) global.crypto = webcrypto;

test("every handler react-app reaches for is one remote-runtime provides", async () => {
  const source = await readFile(new URL("./react-app.js", import.meta.url), "utf8");
  const wanted = [
    ...new Set([...source.matchAll(/handlersRef\.current\.(on[A-Za-z0-9_]+)/g)].map((m) => m[1])),
  ].sort();

  // Without this the guard is vacuous: a regex that stops matching would pass loudest.
  assert.ok(wanted.length > 10, `expected react-app to use many handlers, found ${wanted.length}`);
  // Named one by one, because "every name react-app uses" is satisfied by react-app
  // using fewer names. Deleting a wiring line removes the requirement along with it —
  // which is exactly how a silent channel gets re-introduced.
  for (const required of ["onComposerError", "onGoalError", "onBeginGoalAction", "onDismissGoalError"]) {
    assert.ok(wanted.includes(required), `react-app must still route ${required}`);
  }

  const { createRemoteAppHandlers } = await import("./remote-runtime.js");
  const handlers = createRemoteAppHandlers();

  const missing = wanted.filter((name) => typeof handlers[name] !== "function");
  assert.deepEqual(missing, [], `react-app calls handlers nothing provides: ${missing.join(", ")}`);
});
