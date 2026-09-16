/**
 * Source guards for the Stop → Stopping… wiring. Unit helpers can stay green
 * while render-session / remote still reconcile the wrong snapshot or read a
 * separate Orchestrator boolean that never clears off-screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

test("local reconcileAllStopPending resolves against state.session (real), not the projection", () => {
  const src = readFileSync(join(root, "local/render-session.js"), "utf8");
  const idx = src.indexOf("reconcileAllStopPending(");
  assert.ok(idx >= 0, "render-session must reconcile stop-pending");
  const snippet = src.slice(idx, idx + 420);
  assert.match(
    snippet,
    /stopPendingResolveFromSession\(\s*state\.session\s*,/,
    "must resolve against state.session (real), not the projected `session` local"
  );
  assert.match(
    snippet,
    /stopPendingOverlayFromPin/,
    "must overlay the view-only pin so a lagging thread_activity cannot drop Stopping…"
  );
  assert.doesNotMatch(
    snippet,
    /stopPendingResolveFromSession\(\s*session\s*,/,
    "projected `session` rewrites active_thread_id and omits the live thread"
  );
});

// P1: renderTaskTeam used to run before reconcileAll, so an idle Orchestrator
// snapshot painted Stopping… from the stale map and never re-painted after the
// map was cleared in the same renderSession.
test("local reconcileAllStopPending runs before renderTaskTeam in renderSession", () => {
  const src = readFileSync(join(root, "local/render-session.js"), "utf8");
  const fnStart = src.indexOf("function renderSession(session) {");
  assert.ok(fnStart >= 0);
  // End of renderSession is fuzzy; bound the search to the Tasks gate that
  // calls renderTaskTeam during the same paint.
  const tasksGate = src.indexOf("if (onTaskScreen) {\n      renderTaskTeam(session);", fnStart);
  assert.ok(tasksGate > fnStart, "renderSession must still paint Tasks via renderTaskTeam");
  const reconcileIdx = src.indexOf("reconcileAllStopPending(", fnStart);
  assert.ok(reconcileIdx >= 0, "renderSession must reconcile stop-pending");
  assert.ok(
    reconcileIdx < tasksGate,
    "reconcile must run before renderTaskTeam, or Stopping… sticks after idle"
  );
});

test("Orchestrator Stopping… reads the shared map, not a separate boolean", () => {
  const src = readFileSync(join(root, "local/render-session.js"), "utf8");
  assert.match(
    src,
    /stopPending:\s*orchStopPending/,
    "Tasks pane must pass the map-derived flag"
  );
  assert.doesNotMatch(
    src,
    /stopPending:\s*Boolean\(\s*state\.orchestratorStopPending\s*\)/,
    "a separate boolean survives off-screen idle→new-turn"
  );
  assert.doesNotMatch(
    src,
    /state\.orchestratorStopPending\s*=/,
    "must not write a pane-local pending bit"
  );
});

test("remote reconciles stop-pending synchronously for the composer paint", () => {
  const src = readFileSync(join(root, "remote/react-app.js"), "utf8");
  const idx = src.indexOf("reconcileAllStopPending(");
  assert.ok(idx >= 0, "react-app must reconcile stop-pending");
  const block = src.slice(idx, idx + 800);
  assert.match(block, /realSession|reconcileSession/, "must prefer realSession");
  assert.match(
    block,
    /reconciledStopPending/,
    "must bind a sync reconciled map for this paint"
  );
  assert.match(
    block,
    /stopPendingOverlayFromViewedSession/,
    "must overlay the viewed projection when real thread_activity lags"
  );
  const deriveIdx = src.indexOf("deriveSessionRuntime({");
  assert.ok(deriveIdx > idx, "reconcile must precede deriveSessionRuntime");
  const deriveSnippet = src.slice(deriveIdx, deriveIdx + 500);
  assert.match(
    deriveSnippet,
    /stopPendingByThread:\s*reconciledStopPending/,
    "composer must read the sync-reconciled map, not the pre-reconcile store"
  );
});
