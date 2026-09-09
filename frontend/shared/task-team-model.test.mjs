import test from "node:test";
import assert from "node:assert/strict";

import { teamAttention, teamRunIsWorking } from "./task-team-model.js";

function run(overrides = {}) {
  return {
    team_run_id: "team-1",
    title: "Add a parser",
    status: "paused",
    phase: "sub_tasks",
    cwd: "/tmp/wt",
    branch: "task/add-a-parser",
    target_ref: "refs/heads/main",
    tl_thread_id: "tl-1",
    tl_generations: 1,
    sub_tasks: [],
    awaiting: null,
    unresolved: [],
    updated_at: 100,
    ...overrides,
  };
}

// The one acceptance criterion this sub-task exists for: a provider-limit
// pause is not the user's own doing, so it must not read like one — no
// "needs_input" weight, no language that says or implies the user has to
// decide something, and no suggestion that a review is still running (the
// seat diagram already answers that correctly; this is about the text).
test("a provider-paused task does not read as waiting on the user", () => {
  const attention = teamAttention(
    run({ pause_kind: "provider", pause_reason: "Claude turn failed: reached the usage limit" })
  );
  assert.notEqual(
    attention.kind,
    "needs_input",
    "a provider halt is not a question for the user"
  );
  assert.doesNotMatch(
    attention.text,
    /you (paused|did this|asked)|your own/i,
    "must not imply the user caused or must act on this"
  );
  assert.doesNotMatch(
    attention.text,
    /review/i,
    "must not suggest a review is in progress"
  );
  assert.match(
    attention.text,
    /reached the usage limit/,
    "the specifics still come from pause_reason"
  );
  assert.match(attention.text, /resume/i, "must say the task can be resumed");
  assert.equal(
    attention.reason,
    "paused",
    "must share the plain pause's `reason` so the banner keeps its neutral " +
      "styling instead of falling back to the urgent default"
  );
  // The substring checks above all pass on the broken composition too — this
  // is the one assertion that actually catches it: "stopped the work:" plus a
  // `pause_reason` that already contains its own colon reads as two colons in
  // one sentence, and without a period the resume clause runs on with no
  // sentence break.
  assert.equal(
    attention.text,
    "The provider stopped the work. Claude turn failed: reached the usage limit. You can resume once that clears.",
    "exact rendered copy — one colon (from pause_reason itself), and a sentence break before the resume clause"
  );
});

test("a provider pause with no pause_reason still reads sensibly", () => {
  const attention = teamAttention(run({ pause_kind: "provider", pause_reason: null }));
  assert.notEqual(attention, null);
  assert.notEqual(attention.kind, "needs_input");
  assert.match(attention.text, /provider/i);
});

// Branching on `pause_kind`, not on `pause_reason` prose: a `user` pause must
// come out byte-for-byte identical to what `teamAttention` produced before
// `pause_kind` existed.
test("a user-paused task keeps exactly today's attention", () => {
  const attention = teamAttention(run({ pause_kind: "user", pause_reason: "stopped by the user" }));
  assert.deepEqual(attention, { kind: "paused", reason: "paused", text: "stopped by the user" });
});

// Same for a boundary pause (a graceful pause settled at the driver's own
// boundary, or the relay reconciling a stranded pause at restart) — it is
// still the user's own request taking effect, just not synchronously.
test("a boundary-paused task keeps exactly today's attention", () => {
  const attention = teamAttention(
    run({
      pause_kind: "boundary",
      pause_reason: "the relay restarted while the team was pausing",
    })
  );
  assert.deepEqual(attention, {
    kind: "paused",
    reason: "paused",
    text: "the relay restarted while the team was pausing",
  });
});

// An older persisted run never had `pause_kind` at all. It must degrade to
// today's behaviour, not crash on the missing field.
test("a run with no pause_kind at all degrades to today's behaviour", () => {
  const attention = teamAttention(run({ pause_reason: "you paused it" }));
  assert.deepEqual(attention, { kind: "paused", reason: "paused", text: "you paused it" });
});

// The In-progress bucket means "started and not finished", which is not the same
// as "working": `paused` and `resolving` hold the worktree with no driver. Any
// count that says "running" or claims a slot has to ask this instead.
test("teamRunIsWorking separates a live driver from a held worktree", () => {
  // `awaiting_user` is working: its turn is NOT stopped, it is blocked inside
  // the provider's tool callback, so it still holds a driver and a worktree.
  const working = ["running", "pause_pending", "awaiting_user"];
  const idle = ["queued", "paused", "resolving", "blocked"];
  const terminal = ["done", "escalated", "failed", "interrupted", "cancelled"];

  for (const status of working) {
    assert.equal(teamRunIsWorking(run({ status })), true, status);
  }
  for (const status of [...idle, ...terminal]) {
    assert.equal(teamRunIsWorking(run({ status })), false, status);
  }
  assert.equal(teamRunIsWorking(null), false);
  assert.equal(teamRunIsWorking({}), false);
});
