import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { actionDeadlineMs, DEFAULT_ACTION_DEADLINE_MS } from "./action-deadlines.js";

// Read out of the relay rather than copied: a client that gives up under the relay's
// own ceiling reports a failure for work that is still running, and the drift would
// otherwise only show up as a duplicate agent somebody paid for.
function relayBriefCeilingMs() {
  const rust = readFileSync(
    new URL("../../crates/relay-server/src/state/app/delegation.rs", import.meta.url),
    "utf8"
  );
  const ticks = /const BRIEF_WAIT_TICKS: u32 = (\d+);/.exec(rust);
  const tickMs = /const BRIEF_WAIT_TICK_MS: u64 = (\d+);/.exec(rust);
  assert.ok(ticks && tickMs, "the brief wait constants should still exist in delegation.rs");
  return Number(ticks[1]) * Number(tickMs[1]);
}

const RELAY_BRIEF_CEILING_MS = relayBriefCeilingMs();

test("an ordinary action keeps the short deadline", () => {
  assert.equal(actionDeadlineMs("send_message"), DEFAULT_ACTION_DEADLINE_MS);
  assert.equal(actionDeadlineMs("set_goal"), DEFAULT_ACTION_DEADLINE_MS);
});

test("delegate outlives the relay's brief, rather than giving up under it", () => {
  // Giving up first is worse than waiting: the relay carries on and starts the peer,
  // while the phone says it failed — so a retry delegates a second time and bills twice.
  assert.ok(
    actionDeadlineMs("delegate") > RELAY_BRIEF_CEILING_MS,
    `delegate must outlast the relay's ${RELAY_BRIEF_CEILING_MS}ms brief wait, got ${actionDeadlineMs("delegate")}`
  );
});

test("an unknown action is not given the long deadline by accident", () => {
  assert.equal(actionDeadlineMs("something_new"), DEFAULT_ACTION_DEADLINE_MS);
  assert.equal(actionDeadlineMs(undefined), DEFAULT_ACTION_DEADLINE_MS);
});
