import test from "node:test";
import assert from "node:assert/strict";

import {
  availableTeamActions,
  canTalkToTeamLead,
  currentSubTask,
  groupTeamRuns,
  isTerminalTeamStatus,
  isTeamRunDeletable,
  needsYou,
  selectTeamRun,
  sortTeamRuns,
  teamAttention,
  teamListGroupId,
  teamListMeta,
  teamRunProgress,
  teamSeats,
  teamStructure,
  teamStatusTone,
  teamsRevisionOf,
  teamNeedsYouNow,
  teamsNeedingYou,
  teamStatusLabel,
} from "./shared/task-team-model.js";

function run(overrides = {}) {
  return {
    team_run_id: "team-1",
    title: "Add a parser",
    status: "running",
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

function subTask(overrides = {}) {
  return {
    id: "s1",
    title: "Write the parser",
    status: "implementing",
    rounds_used: 0,
    digested: false,
    result_summary: null,
    dev_thread_id: "dev-1",
    reviewer_thread_id: "rev-1",
    ...overrides,
  };
}

function pairStructure() {
  return {
    roles: [
      { id: "pair", name: "Pair programmer", runtime_role: "dev", blurb: "" },
      { id: "reviewer", name: "Reviewer", runtime_role: "reviewer", blurb: "" },
    ],
    bindings: {
      lead: "pair",
      dev: "pair",
      reviewer: "reviewer",
      mr_dev: "pair",
      reporter: "pair",
    },
  };
}

// ---- actions: these mirror backend guards and must not drift ---------------

test("a terminal task offers no actions at all", () => {
  // `require_stoppable_team_run` refuses every stop verb on a terminal run, and
  // resume/resolve need paused/blocked. There is nothing left to offer.
  for (const status of ["done", "escalated", "failed", "interrupted", "cancelled"]) {
    assert.deepEqual(availableTeamActions(status), [], status);
    assert.equal(isTerminalTeamStatus(status), true, status);
    assert.equal(isTeamRunDeletable(status), true, status);
  }
  assert.equal(isTeamRunDeletable("running"), false);
});

test("a blocked task offers only Unblock", () => {
  // `require_stoppable_team_run` refuses pause/stop/cancel with "this task is
  // blocked; resolve it first", and `blocked_team_run_id` takes only `blocked`.
  assert.deepEqual(availableTeamActions("blocked"), ["resolve"]);
});

test("a task already being resolved offers nothing", () => {
  // `begin_resolving_blocked` refuses a second recovery so two drains cannot hit
  // the same threads. A second Unblock button would be an error waiting to happen.
  assert.deepEqual(availableTeamActions("resolving"), []);
});

test("a paused task offers Resume and Cancel, never Pause or Stop", () => {
  // Both would be accepted by the backend and both would do nothing: a paused run
  // has no driver to pause and no turn to stop.
  assert.deepEqual(availableTeamActions("paused"), ["resume", "cancel"]);
});

test("a pausing task offers the escalation, not the pause it already has", () => {
  assert.deepEqual(availableTeamActions("pause_pending"), ["stop", "cancel"]);
});

test("a drivable task offers all three stops", () => {
  for (const status of ["queued", "running", "awaiting_user"]) {
    assert.deepEqual(availableTeamActions(status), ["pause", "stop", "cancel"], status);
  }
});

test("Resume is never offered except on a paused task", () => {
  // `TeamRunStatus::is_resumable` is `matches!(self, Self::Paused)` — nothing else.
  const everyStatus = [
    "queued", "running", "pause_pending", "paused", "awaiting_user", "done",
    "escalated", "blocked", "resolving", "failed", "interrupted", "cancelled",
  ];
  for (const status of everyStatus) {
    const offered = availableTeamActions(status).includes("resume");
    assert.equal(offered, status === "paused", `resume offered for ${status}`);
  }
});

// ---- seats -----------------------------------------------------------------

test("the developer and reviewer seats follow the CURRENT sub-task, not the run", () => {
  // Both get a fresh session per sub-task (and the reviewer per round), so a
  // run-level thread id would open a transcript belonging to finished work.
  const seats = teamSeats(
    run({
      sub_tasks: [
        subTask({ id: "s1", status: "done", dev_thread_id: "dev-old", reviewer_thread_id: "rev-old" }),
        subTask({ id: "s2", status: "implementing", dev_thread_id: "dev-new", reviewer_thread_id: "rev-new" }),
      ],
    })
  );
  assert.deepEqual(seats.map((seat) => seat.role), ["tl", "dev", "reviewer"]);
  assert.equal(seats[0].threadId, "tl-1");
  assert.equal(seats[1].threadId, "dev-new");
  assert.equal(seats[2].threadId, "rev-new");
});

test("an unseated role has no thread to open rather than a plausible one", () => {
  const seats = teamSeats(run({ phase: "intake", sub_tasks: [] }));
  assert.equal(seats[1].threadId, null);
  assert.equal(seats[2].threadId, null);
  assert.equal(seats[0].threadId, "tl-1");
});

test("the phase decides which seat is working", () => {
  const at = (phase, tasks = []) =>
    teamSeats(run({ phase, sub_tasks: tasks })).filter((seat) => seat.state);

  assert.deepEqual(at("intake").map((s) => [s.role, s.state]), [["tl", "working"]]);
  assert.deepEqual(at("planning").map((s) => [s.role, s.state]), [["tl", "working"]]);
  assert.deepEqual(at("mr_gate").map((s) => [s.role, s.state]), [["reviewer", "reviewing"]]);
  assert.deepEqual(at("wrapping").map((s) => [s.role, s.state]), [["tl", "working"]]);
  assert.deepEqual(
    at("sub_tasks", [subTask({ status: "implementing" })]).map((s) => [s.role, s.state]),
    [["dev", "working"]]
  );
  assert.deepEqual(
    at("sub_tasks", [subTask({ status: "pending" })]).map((s) => [s.role, s.state]),
    [["reviewer", "reviewing"]]
  );
  assert.deepEqual(at("finished").map((s) => [s.role, s.state]), []);
});

test("a task with no driver shows nobody working, whatever its phase says", () => {
  // Phase is the last thing the driver recorded, not a claim about right now. A
  // paused run that still animated a working dot would say an agent is running
  // when the whole point of the pause is that none is.
  for (const status of ["paused", "blocked", "resolving", "done", "cancelled"]) {
    const seats = teamSeats(run({ status, phase: "sub_tasks", sub_tasks: [subTask()] }));
    assert.deepEqual(
      seats.filter((seat) => seat.state),
      [],
      `${status} should show no seat working`
    );
  }
});

test("a parked question outranks the driverless rule", () => {
  // The turn is NOT stopped while parked — it is blocked inside the provider's
  // tool callback and continues the moment the answer lands. So the seat really
  // is waiting on a person even though no driver is moving the run.
  const seats = teamSeats(
    run({
      status: "awaiting_user",
      phase: "sub_tasks",
      sub_tasks: [subTask()],
      awaiting: { thread_id: "dev-1", request_id: "ask:1", role: "dev", asked_at: 5 },
    })
  );
  assert.equal(seats[1].state, "needs_input");
});

test("the team lead's question is recognised under the backend's own role name", () => {
  // The backend records `tl`, not `lead`. A mismatch here fails silently — the
  // question card still renders, but nothing on the diagram says who is waiting.
  const seats = teamSeats(
    run({ awaiting: { thread_id: "tl-1", request_id: "ask:2", role: "tl", asked_at: 5 } })
  );
  assert.equal(seats[0].state, "needs_input");
});

test("a pair team is rendered from role bindings, not from fixed seats", () => {
  const seats = teamSeats(
    run({
      phase: "sub_tasks",
      team_structure: pairStructure(),
      sub_tasks: [subTask({ dev_thread_id: "tl-1", reviewer_thread_id: "rev-1" })],
    })
  );
  assert.deepEqual(seats.map((seat) => [seat.role, seat.label]), [
    ["pair", "Pair programmer"],
    ["reviewer", "Reviewer"],
  ]);
  assert.equal(seats[0].threadId, "tl-1");
  assert.equal(seats[0].state, "working");
  assert.equal(seats[0].subTaskTitle, "Write the parser");
  assert.equal(seats[1].threadId, "rev-1");
});

test("runtime dev questions highlight the pair role when lead and dev are bound together", () => {
  const seats = teamSeats(
    run({
      status: "awaiting_user",
      team_structure: pairStructure(),
      awaiting: { thread_id: "tl-1", request_id: "ask:3", role: "dev", asked_at: 5 },
    })
  );
  assert.equal(seats[0].role, "pair");
  assert.equal(seats[0].state, "needs_input");
});

test("missing team structure falls back to the default bindings", () => {
  assert.deepEqual(teamStructure(run()).bindings, {
    lead: "tl",
    dev: "dev",
    reviewer: "reviewer",
    mrDev: "dev",
    reporter: "tl",
  });
});

// ---- attention and ordering ------------------------------------------------

test("a parked question is the loudest thing on a card", () => {
  const attention = teamAttention(
    run({ status: "awaiting_user", awaiting: { role: "dev", request_id: "ask:1" }, pause_reason: "x" })
  );
  assert.equal(attention.kind, "needs_input");
  assert.equal(attention.reason, "question");
  assert.match(attention.text, /developer/);
});

test("a pair programmer question names the pair role", () => {
  const attention = teamAttention(
    run({
      status: "awaiting_user",
      team_structure: pairStructure(),
      awaiting: { role: "dev", request_id: "ask:1" },
    })
  );
  assert.match(attention.text, /pair programmer/);
});

test("every way a task ends up wanting a person is ONE bucket", () => {
  // The mechanisms differ; what the user has to do does not — the developer or
  // the team lead hands them a decision. Four separate pills made the reader
  // classify a failure mode before they could see that anything was waiting.
  for (const status of ["awaiting_user", "escalated", "blocked", "failed", "interrupted"]) {
    assert.equal(needsYou(status), true, status);
    assert.equal(teamStatusLabel(status), "Needs you", status);
    assert.equal(teamAttention(run({ status })).kind, "needs_input", status);
  }
});

test("the specific reason survives the collapse", () => {
  // One bucket for the badge, the sort and the pill — but the banner still has to
  // say WHICH, or the screen can no longer tell you what to do about it.
  assert.equal(teamAttention(run({ status: "blocked" })).reason, "blocked");
  assert.equal(teamAttention(run({ status: "escalated" })).reason, "escalated");
  assert.equal(teamAttention(run({ status: "failed" })).reason, "failed");
  assert.notEqual(
    teamAttention(run({ status: "escalated" })).text,
    teamAttention(run({ status: "blocked" })).text
  );
});

test("attention hides terminal reports once their latest update was read", () => {
  const seenAt = {
    "escalated-1": 100,
    "failed-1": 100,
    "interrupted-1": 100,
  };
  for (const status of ["escalated", "failed", "interrupted"]) {
    assert.equal(
      teamAttention(run({ team_run_id: `${status}-1`, status, updated_at: 100 }), seenAt),
      null,
      status
    );
  }
});

test("attention shows a terminal report again after a newer update", () => {
  const report = run({ team_run_id: "failed-1", status: "failed", updated_at: 200 });
  assert.equal(teamAttention(report, { "failed-1": 100 }).reason, "failed");
});

test("attention never dismisses a question or blocked request as read", () => {
  const seenAt = { "asking-1": 100, "blocked-1": 100 };
  const question = run({
    team_run_id: "asking-1",
    status: "awaiting_user",
    updated_at: 100,
    awaiting: { role: "dev", request_id: "ask:1" },
  });
  const blocked = run({ team_run_id: "blocked-1", status: "blocked", updated_at: 100 });
  assert.equal(teamAttention(question, seenAt).reason, "question");
  assert.equal(teamAttention(blocked, seenAt).reason, "blocked");
});

test("a blocked task explains itself even with no error recorded", () => {
  const attention = teamAttention(run({ status: "blocked", error: null }));
  assert.equal(attention.kind, "needs_input");
  assert.ok(attention.text.length > 0);
});

test("a pause you asked for is not a task asking you for something", () => {
  // Otherwise the badge counts "tasks I have touched" and stops being read.
  const attention = teamAttention(run({ status: "paused", pause_reason: "you paused it" }));
  assert.equal(attention.kind, "paused");
  assert.equal(needsYou("paused"), false);
  assert.equal(needsYou("done"), false);
  assert.equal(needsYou("cancelled"), false);
  assert.equal(needsYou("running"), false);
});

test("a healthy running task needs nothing from the user", () => {
  assert.equal(teamAttention(run()), null);
});

test("tasks wanting the user sort first, and finished tasks sort last but stay", () => {
  // A terminal run must never drop out of the list: its branch is still on disk,
  // and a card that vanished is how a user loses track of the work.
  const sorted = sortTeamRuns([
    run({ team_run_id: "done-1", status: "done", updated_at: 300 }),
    run({ team_run_id: "running-1", status: "running", updated_at: 100 }),
    run({
      team_run_id: "asking-1",
      status: "awaiting_user",
      updated_at: 50,
      awaiting: { role: "dev", request_id: "ask:1" },
    }),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.team_run_id),
    ["asking-1", "running-1", "done-1"]
  );
});

test("an escalated task outranks a running one, terminal though it is", () => {
  // It is finished AND it needs a decision. Sorting it with the done ones because
  // its status happens to be terminal is exactly how it gets forgotten.
  const sorted = sortTeamRuns([
    run({ team_run_id: "done-1", status: "done", updated_at: 400 }),
    run({ team_run_id: "running-1", status: "running", updated_at: 300 }),
    run({ team_run_id: "escalated-1", status: "escalated", updated_at: 10 }),
  ]);
  assert.deepEqual(
    sorted.map((entry) => entry.team_run_id),
    ["escalated-1", "running-1", "done-1"]
  );
});

test("the badge counts every task waiting on a person, not just parked questions", () => {
  assert.equal(
    teamsNeedingYou([
      run({ status: "running" }),
      run({ status: "escalated" }),
      run({ status: "blocked" }),
      run({ status: "done" }),
      run({ status: "paused", pause_reason: "you paused it" }),
    ]),
    2
  );
  assert.equal(teamsNeedingYou([]), 0);
  assert.equal(teamsNeedingYou(null), 0);
});

// ---- odds and ends ---------------------------------------------------------

test("progress counts every settled sub-task, including skipped and escalated ones", () => {
  const progress = teamRunProgress(
    run({
      sub_tasks: [
        subTask({ status: "done" }),
        subTask({ status: "skipped" }),
        subTask({ status: "escalated" }),
        subTask({ status: "implementing" }),
      ],
    })
  );
  assert.deepEqual(progress, { done: 3, total: 4 });
});

test("currentSubTask is null once everything settled", () => {
  assert.equal(currentSubTask(run({ sub_tasks: [subTask({ status: "done" })] })), null);
  assert.equal(currentSubTask(run({ sub_tasks: [] })), null);
  // One a replan retired is settled too, not the step the team is on.
  assert.equal(currentSubTask(run({ sub_tasks: [subTask({ status: "superseded" })] })), null);
});

test("the team lead is conversable only while the task is paused", () => {
  // Mirrors `team_thread_gate` -> TlWhilePaused. At any other moment the driver
  // owns the next turn on that thread.
  assert.equal(canTalkToTeamLead(run({ status: "paused" })), true);
  assert.equal(canTalkToTeamLead(run({ status: "running" })), false);
  assert.equal(canTalkToTeamLead(run({ status: "awaiting_user" })), false);
  assert.equal(canTalkToTeamLead(run({ status: "paused", tl_thread_id: "" })), false);
});

test("selectTeamRun finds by id and tolerates a stale one", () => {
  const teams = [run({ team_run_id: "team-1" }), run({ team_run_id: "team-2" })];
  assert.equal(selectTeamRun(teams, "team-2").team_run_id, "team-2");
  assert.equal(selectTeamRun(teams, "team-gone"), null);
  assert.equal(selectTeamRun(teams, null), null);
});

test("an unknown status degrades to a neutral tone instead of throwing", () => {
  // `TeamRunStatus` decodes leniently on the backend precisely so a forward-compat
  // state file cannot strand a run. The UI must be equally forgiving.
  assert.equal(teamStatusTone("some_future_status"), null);
  assert.equal(teamStatusTone("running"), "working");
  assert.equal(teamStatusTone("awaiting_user"), "needs_input");
});

test("a snapshot with no tasks still yields a revision the cache will act on", () => {
  // The relay skips `teams_revision` on the wire when it is 0, so every relay that
  // has never run a task omits it entirely. The cache bails on a null revision by
  // design (an older relay must not provoke a fetch), so reading the field raw
  // means `sync(undefined)` returns immediately, the cache never loads, and the
  // Task screen shows "Loading tasks…" forever — for the exact population most
  // likely to open it first.
  assert.equal(teamsRevisionOf({ teams_revision: 7 }), 7);
  assert.equal(teamsRevisionOf({ teams_revision: 0 }), 0);
  assert.equal(teamsRevisionOf({}), 0, "an omitted revision means zero, not unknown");
  assert.equal(teamsRevisionOf(null), 0);
  assert.equal(teamsRevisionOf(undefined), 0);
});

test("the badge can return to zero — a report is discharged by reading it", () => {
  // The rule: you can dismiss a REPORT, you cannot dismiss a REQUEST.
  //
  // Collapsing every wanting-a-person state into one bucket is right for the pill
  // and the sort, but three of those states are terminal and offer no action at
  // all. Counting them unconditionally pins the badge at >= 1 forever the first
  // time a task fails — which is precisely what `renderTasksBadge` exists to
  // avoid, and what makes a badge stop being read.
  const settled = [
    run({ team_run_id: "escalated-1", status: "escalated", updated_at: 100 }),
    run({ team_run_id: "failed-1", status: "failed", updated_at: 100 }),
    run({ team_run_id: "interrupted-1", status: "interrupted", updated_at: 100 }),
  ];
  assert.equal(teamsNeedingYou(settled, {}), 3, "unread reports still ask for you");
  assert.equal(
    teamsNeedingYou(settled, { "escalated-1": 100, "failed-1": 100, "interrupted-1": 100 }),
    0,
    "once read, a finished task must stop nagging — there is nothing left to do about it"
  );
});

test("looking at a task does NOT dismiss one that is actually waiting on you", () => {
  // A parked question is not answered by being looked at, and a blocked run still
  // holds its worktree. Letting a glance clear those would lose the one signal
  // the screen exists to carry.
  const live = [
    run({
      team_run_id: "asking-1",
      status: "awaiting_user",
      updated_at: 100,
      awaiting: { role: "dev", request_id: "ask:1" },
    }),
    run({ team_run_id: "blocked-1", status: "blocked", updated_at: 100 }),
  ];
  const seen = { "asking-1": 100, "blocked-1": 100 };
  assert.equal(teamsNeedingYou(live, seen), 2);
});

test("a settled task that changes after you read it asks again", () => {
  // `updated_at` is the read receipt, not a boolean. A run that moves — a late
  // report write, a resolve that re-settles it — is new information.
  const settled = [run({ team_run_id: "escalated-1", status: "escalated", updated_at: 200 })];
  assert.equal(teamsNeedingYou(settled, { "escalated-1": 100 }), 1);
  assert.equal(teamsNeedingYou(settled, { "escalated-1": 200 }), 0);
});

test("teamsNeedingYou tolerates a missing seen map", () => {
  const settled = [run({ status: "escalated" })];
  assert.equal(teamsNeedingYou(settled), 1);
  assert.equal(teamsNeedingYou(settled, null), 1);
});

test("groupTeamRuns puts each run in exactly one 12b bucket", () => {
  const teams = [
    run({ team_run_id: "a", status: "awaiting_user", awaiting: { role: "dev" } }),
    run({ team_run_id: "b", status: "running" }),
    run({ team_run_id: "c", status: "queued" }),
    run({ team_run_id: "d", status: "done" }),
    run({ team_run_id: "e", status: "cancelled" }),
  ];
  const groups = groupTeamRuns(teams);
  assert.deepEqual(
    groups.needs_you.map((r) => r.team_run_id),
    ["a"]
  );
  assert.deepEqual(
    groups.in_progress.map((r) => r.team_run_id),
    ["b"]
  );
  assert.deepEqual(
    groups.queued.map((r) => r.team_run_id),
    ["c"]
  );
  assert.deepEqual(
    groups.pending_merge.map((r) => r.team_run_id),
    ["d"]
  );
  assert.deepEqual(
    groups.finished.map((r) => r.team_run_id),
    ["e"]
  );
});

test("an unread terminal report stays in Needs you, not Finished", () => {
  // Same attention rule as the badge: a report you have not read still asks.
  assert.equal(teamListGroupId(run({ status: "escalated", updated_at: 50 }), {}), "needs_you");
  assert.equal(
    teamListGroupId(run({ team_run_id: "team-1", status: "escalated", updated_at: 50 }), {
      "team-1": 50,
    }),
    "finished"
  );
});

test("sidebar meta is one short line — no token counts", () => {
  assert.equal(
    teamListMeta(run({ status: "awaiting_user", awaiting: { role: "tl" } }), "needs_you"),
    "Needs you"
  );
  assert.equal(
    teamListMeta(
      run({
        status: "running",
        sub_tasks: [subTask(), subTask({ id: "s2", status: "done" })],
      }),
      "in_progress"
    ),
    "1/2"
  );
  assert.equal(teamListMeta(run({ status: "done" }), "pending_merge"), "Ready to merge");
  assert.doesNotMatch(teamListMeta(run({ status: "running" }), "in_progress"), /token|k\b/i);
});

test("a paused task with no sub-tasks shows Paused, not the phase it paused during", () => {
  // Criterion 6: a provider halt or a user pause must not claim a review (or a
  // build) is still running by falling through to the phase label.
  assert.equal(
    teamListMeta(run({ status: "paused", phase: "design_review", sub_tasks: [] }), "in_progress"),
    "Paused"
  );
});

test("a paused task that has sub-tasks still shows the fraction", () => {
  assert.equal(
    teamListMeta(
      run({
        status: "paused",
        phase: "sub_tasks",
        sub_tasks: [subTask(), subTask({ id: "s2", status: "done" })],
      }),
      "in_progress"
    ),
    "1/2"
  );
});
