import test from "node:test";
import assert from "node:assert/strict";

import {
  PROGRESS_VERBS,
  createVerbCycler,
  isProgressStalled,
  progressPhaseLabel,
  toolGerund,
} from "./progress-verbs.js";

test("verb cycler never picks the same verb twice in a row", () => {
  const cycler = createVerbCycler();
  let prev = null;
  for (let i = 0; i < 200; i += 1) {
    const verb = cycler.next();
    assert.ok(PROGRESS_VERBS.includes(verb));
    assert.notEqual(verb, prev);
    prev = verb;
  }
});

test("verb cycler walks the entire pool given a deterministic RNG", () => {
  const verbs = ["alpha", "beta", "gamma", "delta"];
  let counter = 0;
  const cycler = createVerbCycler({
    verbs,
    random: () => {
      const r = (counter * 0.27 + 0.13) % 1;
      counter += 1;
      return r;
    },
  });
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(cycler.next());
  assert.deepEqual([...seen].sort(), [...verbs].sort());
});

test("toolGerund handles common Claude tool names", () => {
  assert.equal(toolGerund("Bash"), "Bashing");
  assert.equal(toolGerund("Edit"), "Editing");
  assert.equal(toolGerund("Read"), "Reading");
  assert.equal(toolGerund("Write"), "Writing");
  assert.equal(toolGerund("Grep"), "Grepping");
  assert.equal(toolGerund("WebFetch"), "WebFetching");
});

test("toolGerund passes through names already in gerund form", () => {
  assert.equal(toolGerund("Pondering"), "Pondering");
});

test("toolGerund tolerates null/empty input", () => {
  assert.equal(toolGerund(null), null);
  assert.equal(toolGerund(""), null);
  assert.equal(toolGerund("   "), null);
});

test("progressPhaseLabel maps phases to user-facing labels", () => {
  assert.equal(progressPhaseLabel("thinking", null, "Pondering"), "Pondering…");
  assert.equal(progressPhaseLabel("streaming", null, "Brewing"), "Brewing…");
  assert.equal(progressPhaseLabel("tool", "Bash", "ignored"), "Bashing…");
  assert.equal(progressPhaseLabel("tool", null, "Tinkering"), "Tinkering…");
  assert.equal(progressPhaseLabel("waiting_approval", null, null), "Waiting on you");
  assert.equal(progressPhaseLabel(null, null, null), null);
  assert.equal(progressPhaseLabel("unknown_phase", null, null), null);
});

test("progressPhaseLabel falls back when no verb is supplied", () => {
  assert.equal(progressPhaseLabel("thinking", null, null), "Thinking…");
  assert.equal(progressPhaseLabel("streaming", null, null), "Streaming…");
});

test("isProgressStalled flips once we've been silent past the threshold", () => {
  const session = {
    current_phase: "thinking",
    last_progress_at: 1000,
    server_time: 1010,
  };
  assert.equal(isProgressStalled(session), false);
  assert.equal(isProgressStalled(session, { now: 1029 }), false);
  assert.equal(isProgressStalled(session, { now: 1031 }), true);
});

test("isProgressStalled returns false when no phase is active", () => {
  assert.equal(
    isProgressStalled({ current_phase: null, last_progress_at: 1000 }, { now: 9999 }),
    false,
  );
  assert.equal(
    isProgressStalled({ current_phase: "thinking", last_progress_at: null }, { now: 9999 }),
    false,
  );
  assert.equal(isProgressStalled(null), false);
});

test("isProgressStalled honors custom threshold", () => {
  const session = {
    current_phase: "tool",
    last_progress_at: 100,
  };
  assert.equal(isProgressStalled(session, { now: 105, thresholdSec: 10 }), false);
  assert.equal(isProgressStalled(session, { now: 111, thresholdSec: 10 }), true);
});
