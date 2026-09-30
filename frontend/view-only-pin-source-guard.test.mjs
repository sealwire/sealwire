// P1 regression: app.js's `renderer.renderSession` wrap freezes the thread
// the user is viewing into a view-only pin when the ACTIVE thread switches
// out from under it, by reading "the live session a moment ago" off
// state.session. lifecycle.js's applySessionSnapshot used to be the only
// writer of state.session on this path, and it wrote AFTER calling
// renderSession — so state.session still held the old value when this wrap
// read it. Once applySessionSnapshot had to advance state.session
// synchronously itself (queue() defers only the paint, never the write),
// that stopped being true: state.session already equals
// the NEW session by the time this wrap runs, on every path (interactive or
// not). lifecycle.js now stashes the outgoing session on
// state.previousLiveSessionForPin before overwriting it (see
// local/session/lifecycle-snapshot-flush.test.mjs for that half, which is
// real, run code); this guard is the other half — app.js actually has to
// read the stash, not state.session, or the fix is inert. A runtime
// reproduction would need a DOM, the whole import graph and a relay to talk
// to (see boot-tdz-guard.test.mjs) — textual is the point here, not a
// shortcut around it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_SOURCE = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const LIFECYCLE_SOURCE = readFileSync(
  new URL("./local/session/lifecycle.js", import.meta.url),
  "utf8"
);

test("app.js's renderSession wrap reads the stashed previous-live-session, not state.session, for the view-only pin", () => {
  const wrapStart = APP_SOURCE.indexOf("function wrappedRenderSession(session) {");
  assert.ok(wrapStart >= 0, "app.js should still define wrappedRenderSession(session)");
  const pinBuildStart = APP_SOURCE.indexOf("buildViewOnlyPin(", wrapStart);
  assert.ok(pinBuildStart >= 0, "wrappedRenderSession should still build a view-only pin");
  const prologue = APP_SOURCE.slice(wrapStart, pinBuildStart);
  assert.match(
    prologue,
    /const previousLiveSession = state\.previousLiveSessionForPin \|\| state\.session;/,
    "the pin's source session must prefer the stash lifecycle.js writes over state.session, " +
      "which already holds the NEW session by the time this wrap runs"
  );
});

test("lifecycle.js's applySessionSnapshot stashes the outgoing session before overwriting state.session", () => {
  const stashIndex = LIFECYCLE_SOURCE.indexOf("state.previousLiveSessionForPin = state.session;");
  assert.ok(
    stashIndex >= 0,
    "applySessionSnapshot should still stash the outgoing session for app.js's view-only pin"
  );
  const overwriteIndex = LIFECYCLE_SOURCE.indexOf("state.session = merged;", stashIndex);
  assert.ok(
    overwriteIndex > stashIndex,
    "the stash must run BEFORE state.session is overwritten with the new snapshot, " +
      "or it would just be stashing the already-new session"
  );
});
