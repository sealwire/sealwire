// Pure model for the Task screen. No DOM, no storage, no fetch — so the seat,
// status and action rules can be unit-tested in isolation.
//
// Every rule here MIRRORS a backend rule; none of them invents one. Where a
// comment cites a guard, that guard is authoritative and this is a hint: the
// relay refuses the action regardless of what this file allows.

// `TeamRunStatus::is_terminal` — crates/relay-server/src/state/team.rs.
const TERMINAL_STATUSES = new Set([
  "done",
  "escalated",
  "failed",
  "interrupted",
  "cancelled",
]);

// Statuses that hold the worktree with no driver entitled to move the run.
// `TeamRunStatus::is_settled_without_driver`.
const SETTLED_WITHOUT_DRIVER = new Set(["paused", "blocked", "resolving"]);

export const TEAM_ROLES = Object.freeze(["tl", "dev", "reviewer"]);

export const TEAM_ROLE_LABELS = Object.freeze({
  tl: "Team lead",
  lead: "Team lead",
  dev: "Developer",
  reviewer: "Reviewer",
  pair: "Pair programmer",
});

const DEFAULT_TEAM_STRUCTURE = Object.freeze({
  roles: Object.freeze([
    Object.freeze({ id: "tl", name: "Planner", runtimeRole: "tl", blurb: "" }),
    Object.freeze({ id: "dev", name: "Implementer", runtimeRole: "dev", blurb: "" }),
    Object.freeze({ id: "reviewer", name: "Reviewer", runtimeRole: "reviewer", blurb: "" }),
  ]),
  bindings: Object.freeze({
    lead: "tl",
    dev: "dev",
    reviewer: "reviewer",
    mrDev: "dev",
    reporter: "tl",
  }),
});

// Every way a task can end up wanting a person, collapsed into one bucket.
//
// The mechanisms differ — a parked question has a live turn, an escalation ran
// out of rounds, a block could not confirm a stop — but what the user has to DO
// is the same shape every time: the developer or the team lead hands them a
// decision. Splitting them across four pills makes the reader classify a failure
// mode before they can see that something is waiting, which is the one thing the
// screen exists to say. The specific reason still appears, one line down, in the
// banner and the card's attention line.
const NEEDS_YOU_STATUSES = new Set([
  "awaiting_user",
  "escalated",
  "blocked",
  "failed",
  "interrupted",
]);

export function needsYou(status) {
  return NEEDS_YOU_STATUSES.has(status);
}

/**
 * Whether a driver is entitled to move this run right now.
 *
 * The list view groups `paused` and `resolving` under "In progress" — right for
 * a bucket that means "started and not finished", wrong for any count that says
 * "running", because both hold the worktree with nothing working it. Anything
 * reporting activity or slot occupancy must ask this, not the bucket size.
 */
export function teamRunIsWorking(run) {
  const status = run?.status;
  return Boolean(status)
    && !SETTLED_WITHOUT_DRIVER.has(status)
    && !TERMINAL_STATUSES.has(status)
    && status !== "queued";
}

const STATUS_LABELS = Object.freeze({
  queued: "Queued",
  running: "Running",
  pause_pending: "Pausing",
  paused: "Paused",
  awaiting_user: "Needs you",
  done: "Done",
  escalated: "Needs you",
  blocked: "Needs you",
  resolving: "Resolving",
  failed: "Needs you",
  interrupted: "Needs you",
  cancelled: "Cancelled",
});

// Reuses the thread-dot vocabulary (`frontend/shared/thread-dot.js`) rather than
// inventing a fourth status palette: needs_input / working / reviewing /
// completed, plus null for idle.
const STATUS_TONES = Object.freeze({
  queued: "working",
  running: "working",
  pause_pending: "working",
  paused: null,
  awaiting_user: "needs_input",
  done: "completed",
  escalated: "needs_input",
  blocked: "needs_input",
  resolving: "working",
  failed: "needs_input",
  interrupted: "needs_input",
  cancelled: null,
});

const PHASE_LABELS = Object.freeze({
  intake: "Sizing up the task",
  design: "Designing",
  design_review: "Reviewing the design",
  planning: "Splitting into sub-tasks",
  sub_tasks: "Building",
  mr_gate: "Reviewing the whole change",
  wrapping: "Writing the report",
  finished: "Finished",
});

export function isTerminalTeamStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/** Finished task cards may be permanently deleted. Mirrors the backend terminal set. */
export function isTeamRunDeletable(status) {
  return isTerminalTeamStatus(status);
}

export function teamStatusLabel(status) {
  return STATUS_LABELS[status] || status || "Unknown";
}

export function teamStatusTone(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_TONES, status)
    ? STATUS_TONES[status]
    : null;
}

export function teamPhaseLabel(phase) {
  return PHASE_LABELS[phase] || phase || "";
}

/**
 * The snapshot's Teams cache key, with the absent case resolved.
 *
 * The relay skips `teams_revision` on the wire while it is 0, so a relay that has
 * never run a task omits it entirely. The cache deliberately bails on a null
 * revision — an older relay must not provoke a fetch — so reading the field raw
 * means the very first visit to the Task screen never fetches, never loads, and
 * sits on "Loading tasks…" forever. An omitted revision means zero, not unknown.
 */
export function teamsRevisionOf(session) {
  return session?.teams_revision ?? 0;
}

export function selectTeamRun(teams, teamRunId) {
  if (!teamRunId) return null;
  return (teams || []).find((run) => run?.team_run_id === teamRunId) || null;
}

/**
 * Which whole-run actions the backend would accept right now.
 *
 * Mirrors three guards exactly:
 *   - `require_stoppable_team_run` — pause/stop/cancel refuse a TERMINAL run and
 *     refuse `blocked`/`resolving` ("resolve it first").
 *   - `TeamRunStatus::is_resumable` — resume takes `paused` and nothing else.
 *   - `blocked_team_run_id` — resolve takes `blocked` and nothing else.
 *
 * Offering a button the relay would refuse is worse than offering none: the
 * refusal arrives as an error toast for an action the user was invited to take.
 */
export function availableTeamActions(status) {
  if (isTerminalTeamStatus(status)) {
    return [];
  }
  if (status === "blocked") {
    return ["resolve"];
  }
  if (status === "resolving") {
    // A recovery is already draining. A second one is refused by
    // `begin_resolving_blocked` so two drains cannot hit the same threads.
    return [];
  }
  if (status === "paused") {
    // Pause is a no-op here and Stop would stop nothing — the run already has no
    // driver. Resume and Cancel are the only two that change anything.
    return ["resume", "cancel"];
  }
  if (status === "pause_pending") {
    // A pause is already requested and settles at the next boundary. Offering
    // Pause again would look like it did not take; Stop is the real escalation.
    return ["stop", "cancel"];
  }
  return ["pause", "stop", "cancel"];
}

export const TEAM_ACTION_LABELS = Object.freeze({
  pause: "Pause",
  stop: "Stop now",
  cancel: "Cancel",
  resume: "Resume",
  resolve: "Unblock",
});

export const TEAM_ACTION_HINTS = Object.freeze({
  pause: "Finish the current step, then stop.",
  stop: "Stop the current step now. The task stays resumable.",
  cancel: "Stop now and give up the slot. The branch and its commits survive.",
  resume: "Start a fresh driver from where the task left off.",
  resolve: "Drain the task's threads and settle it so it can be resumed.",
});

/**
 * The sub-task the team is on right now: the first that has not settled.
 *
 * `null` once every sub-task is terminal, which is also true before the team lead
 * has split the work at all.
 */
export function currentSubTask(run) {
  const subTasks = run?.sub_tasks || [];
  return subTasks.find((task) => !isTerminalSubTaskStatus(task?.status)) || null;
}

const TERMINAL_SUB_TASK_STATUSES = new Set([
  "done",
  "escalated",
  "failed",
  "skipped",
  "superseded",
]);

export function isTerminalSubTaskStatus(status) {
  return TERMINAL_SUB_TASK_STATUSES.has(status);
}

export function teamRunProgress(run) {
  const subTasks = run?.sub_tasks || [];
  const done = subTasks.filter((task) => isTerminalSubTaskStatus(task?.status)).length;
  return { done, total: subTasks.length };
}

// Which seat the run's PHASE puts the work in. Phase is exposed precisely to say
// where the work is, so reading it is mirroring rather than guessing. During
// `sub_tasks` the phase alone is not enough — the sub-task's own status decides
// whether the developer or the reviewer holds it.
function activeRoleForPhase(run, structure = teamStructure(run)) {
  const bindings = structure.bindings;
  switch (run?.phase) {
    case "intake":
    case "design":
    case "planning":
    case "wrapping":
      return bindings.lead;
    case "design_review":
    case "mr_gate":
      return bindings.reviewer;
    case "sub_tasks":
      return currentSubTask(run)?.status === "implementing" ? bindings.dev : bindings.reviewer;
    default:
      return null;
  }
}

/**
 * The pinned team roles, in diagram order, each with the thread it can open.
 *
 * A role can own more than one semantic slot. Pair programming is just
 * `lead == dev`, so the single Pair node opens the same thread during planning
 * and implementation.
 */
export function teamSeats(run) {
  const task = currentSubTask(run);
  const structure = teamStructure(run);
  const activeRole = activeRoleForPhase(run, structure);
  const bindings = structure.bindings;
  // A run with no driver is not working, whatever its phase last recorded.
  const driverless = SETTLED_WITHOUT_DRIVER.has(run?.status) || isTerminalTeamStatus(run?.status);
  const awaitingRole = normalizeAwaitingRole(run?.awaiting?.role, structure);

  return structure.roles.map((roleDef) => {
    const role = roleDef.id;
    const threadId = threadIdForRole(run, task, structure, role);

    let state = null;
    if (awaitingRole === role) {
      // A parked question outranks everything: it is the one thing on this screen
      // that a person has to act on. It survives `driverless` because the turn is
      // NOT stopped — it is blocked inside the provider's tool callback.
      state = "needs_input";
    } else if (!driverless && activeRole === role) {
      state = role === bindings.reviewer ? "reviewing" : "working";
    }

    return {
      role,
      label: roleDef.name || TEAM_ROLE_LABELS[role] || role,
      threadId,
      state,
      subTaskTitle:
        role === bindings.dev || role === bindings.reviewer ? task?.title || null : null,
    };
  });
}

export function teamStructure(run) {
  const raw = run?.team_structure;
  if (!raw || typeof raw !== "object") {
    return {
      roles: DEFAULT_TEAM_STRUCTURE.roles.map((role) => ({ ...role })),
      bindings: { ...DEFAULT_TEAM_STRUCTURE.bindings },
    };
  }
  const rawRoles = Array.isArray(raw.roles) && raw.roles.length
    ? raw.roles
    : DEFAULT_TEAM_STRUCTURE.roles;
  const roles = rawRoles
    .map((role) => ({
      id: String(role?.id || "").trim(),
      name: String(role?.name || TEAM_ROLE_LABELS[role?.id] || role?.id || "Role"),
      runtimeRole: String(role?.runtime_role ?? role?.runtimeRole ?? "dev"),
      blurb: String(role?.blurb || ""),
    }))
    .filter((role) => role.id);
  const bindings = raw.bindings || {};
  const resolved = {
    lead: bindings.lead || DEFAULT_TEAM_STRUCTURE.bindings.lead,
    dev: bindings.dev || DEFAULT_TEAM_STRUCTURE.bindings.dev,
    reviewer: bindings.reviewer || DEFAULT_TEAM_STRUCTURE.bindings.reviewer,
    mrDev: bindings.mr_dev ?? bindings.mrDev ?? DEFAULT_TEAM_STRUCTURE.bindings.mrDev,
    reporter: bindings.reporter || DEFAULT_TEAM_STRUCTURE.bindings.reporter,
  };
  return {
    roles: roles.length ? roles : DEFAULT_TEAM_STRUCTURE.roles.map((role) => ({ ...role })),
    bindings: resolved,
  };
}

function threadIdForRole(run, task, structure, role) {
  const bindings = structure.bindings;
  if (role === bindings.reviewer) {
    return task?.reviewer_thread_id || run?.reviewer_thread_id || null;
  }
  if (role === bindings.dev) {
    return task?.dev_thread_id || (bindings.dev === bindings.lead ? run?.tl_thread_id || null : null);
  }
  if (role === bindings.mrDev) {
    return run?.mr_dev_thread_id || null;
  }
  if (role === bindings.lead) {
    return run?.tl_thread_id || null;
  }
  return null;
}

// The backend records runtime roles (`tl` or `dev`) for parked questions.
// Resolve those through this run's bindings so a pair-programming run highlights
// the Pair node instead of a non-existent Developer node.
function normalizeAwaitingRole(role, structure) {
  if (!role) return null;
  if (structure.roles.some((candidate) => candidate.id === role)) return role;
  if (role === "tl" || role === "lead") return structure.bindings.lead;
  if (role === "dev") return structure.bindings.dev;
  if (role === "reviewer") return structure.bindings.reviewer;
  return null;
}

function roleAttentionName(run, roleId) {
  const role = teamStructure(run).roles.find((candidate) => candidate.id === roleId);
  return String(role?.name || TEAM_ROLE_LABELS[roleId] || roleId || "team").toLowerCase();
}

/**
 * The one line that answers "does this need me?".
 *
 * Ordered by how much it costs the user to miss it: a parked question stops the
 * task until answered, a block holds the worktree, and a pause is the user's own
 * doing so it comes last.
 */
export function teamAttention(run, seenAt = {}) {
  if (!run) return null;
  if (run.awaiting) {
    const who = roleAttentionName(run, normalizeAwaitingRole(run.awaiting.role, teamStructure(run)));
    return {
      kind: "needs_input",
      reason: "question",
      text: `The ${who} asked you a question.`,
    };
  }
  if (run.status === "blocked") {
    return {
      kind: "needs_input",
      reason: "blocked",
      text: run.error || "A step could not be confirmed stopped. Unblock it to continue.",
    };
  }
  if (
    isTerminalTeamStatus(run.status)
    && (seenAt?.[run.team_run_id] || 0) >= (run.updated_at || 0)
  ) {
    return null;
  }
  if (run.status === "escalated") {
    return {
      kind: "needs_input",
      reason: "escalated",
      // Says what is actually on offer. There is no "try again" action — the run
      // is terminal — so the honest next step is to read what it could not settle
      // and take the branch from there.
      text: "The team ran out of rounds. Its branch and commits are on disk; what it could not settle is below.",
    };
  }
  if (run.status === "failed" || run.status === "interrupted") {
    return {
      kind: "needs_input",
      reason: "failed",
      // No "start it again", no "drop it": both are terminal, `availableTeamActions`
      // returns nothing, and there is no delete endpoint. Naming actions that do
      // not exist is the same defect the escalated copy was fixed for.
      text:
        run.error
        || `The task stopped as ${run.status}. Its branch is on disk; nothing is running.`,
    };
  }
  if (run.status === "awaiting_user") {
    // The status without the record. The driver writes both together, but a
    // snapshot can be read between them — and "parked, waiting on you" is far too
    // important to fall through to "nothing to report" on a field that is only
    // there to say WHO is asking.
    return {
      kind: "needs_input",
      reason: "question",
      text: "The team asked you a question.",
    };
  }
  if (run.status === "paused" && run.pause_kind === "provider") {
    // Same `reason` as the branch below (so the banner keeps the neutral
    // `.is-paused` styling instead of falling back to the urgent default) —
    // only the text differs. Still not `needs_input`, since a limit resets on
    // its own, but this one is NOT the user's doing, so it must not read like
    // the assumption the branch below is written for. `pause_reason` supplies
    // the specifics; this only supplies the framing prose is not trusted to
    // carry (see the module docs: branch on `pause_kind`, never match prose).
    return {
      kind: "paused",
      reason: "paused",
      text: run.pause_reason
        ? `The provider stopped the work. ${run.pause_reason}. You can resume once that clears.`
        : "The provider stopped the work. You can resume once that clears.",
    };
  }
  if (run.status === "paused" && run.pause_reason) {
    // Not `needs_input`: you did this, and you already know. Surfacing your own
    // pause with the same weight as a question the team cannot proceed without
    // would make the badge mean "tasks I have touched". Covers `pause_kind`
    // `"user"` and `"boundary"` alike (both are the user's own request taking
    // effect, just not synchronously) and an older record with no `pause_kind`
    // at all.
    return { kind: "paused", reason: "paused", text: run.pause_reason };
  }
  return null;
}

/**
 * Whether the team lead is conversable, mirroring
 * `RelayState::team_thread_gate` -> `TlWhilePaused`.
 *
 * The composer's own gating is enforced server-side and read from the snapshot;
 * this is only for the Task screen's "talk to the lead" affordance, so it must
 * not be the thing anything relies on.
 */
export function canTalkToTeamLead(run) {
  return Boolean(run && run.status === "paused" && run.tl_thread_id);
}

/**
 * Newest first, but anything wanting the user first of all.
 *
 * A terminal run stays in the list — its branch is still on disk, and a card that
 * vanished is how a user loses track of the work.
 */
export function sortTeamRuns(teams) {
  return [...(teams || [])].sort((left, right) => {
    // Wanting a person outranks everything, INCLUDING being terminal. An
    // escalated task is finished and still needs a decision; sorting it with the
    // done ones because its status is terminal is how it gets forgotten.
    const leftNeeds = teamAttention(left)?.kind === "needs_input" ? 1 : 0;
    const rightNeeds = teamAttention(right)?.kind === "needs_input" ? 1 : 0;
    if (leftNeeds !== rightNeeds) return rightNeeds - leftNeeds;
    const leftSettled = isTerminalTeamStatus(left?.status) ? 1 : 0;
    const rightSettled = isTerminalTeamStatus(right?.status) ? 1 : 0;
    if (leftSettled !== rightSettled) return leftSettled - rightSettled;
    return (right?.updated_at || 0) - (left?.updated_at || 0);
  });
}

/**
 * Whether a task is asking for a person RIGHT NOW, given what has been read.
 *
 * The line is between a request and a report, and it is the whole reason the
 * badge stays meaningful:
 *
 *   - A REQUEST (`awaiting_user`, `blocked`) cannot be dismissed by looking at
 *     it. The question is still unanswered; the blocked run still holds its
 *     worktree. Only acting clears it.
 *   - A REPORT (`escalated`, `failed`, `interrupted`) can. Those are terminal and
 *     `availableTeamActions` returns nothing for them, so a badge that counted
 *     them unconditionally would sit at >= 1 forever after the first failure —
 *     the exact "stops meaning anything" failure the badge is supposed to avoid.
 *
 * `seenAt` maps run id to the `updated_at` that was read, not a boolean: a
 * settled run that moves afterwards is new information and asks again.
 */
export function teamNeedsYouNow(run, seenAt = {}) {
  return teamAttention(run, seenAt)?.kind === "needs_input";
}

/** How many tasks are waiting on a person — what the sidebar badge counts. */
export function teamsNeedingYou(teams, seenAt = {}) {
  return (teams || []).filter((run) => teamNeedsYouNow(run, seenAt)).length;
}

/**
 * The four list groups from mockup 12b, plus a quiet "Finished" bucket for
 * terminal runs that are neither awaiting merge nor still asking for a person.
 *
 * A run lands in exactly one group. Order inside each group is the caller's
 * job — typically `sortTeamRuns` first, then partition.
 */
export const TEAM_LIST_GROUPS = Object.freeze([
  { id: "needs_you", label: "Needs you" },
  { id: "in_progress", label: "In progress" },
  { id: "queued", label: "Queued" },
  { id: "pending_merge", label: "Ready to merge" },
  { id: "finished", label: "Finished" },
]);

/**
 * Which list group a run belongs in.
 *
 * `needs_you` outranks everything (including `done`/`failed`), matching the
 * attention rule that a report you have not read still asks for you. `queued`
 * is only the not-yet-started status. `pending_merge` is `done` — the branch is
 * ready and nothing else is asking. Everything else still alive is
 * `in_progress`; quiet terminals fall into `finished`.
 */
export function teamListGroupId(run, seenAt = {}) {
  if (teamNeedsYouNow(run, seenAt)) {
    return "needs_you";
  }
  if (run?.status === "queued") {
    return "queued";
  }
  if (run?.status === "done") {
    return "pending_merge";
  }
  if (isTerminalTeamStatus(run?.status)) {
    return "finished";
  }
  return "in_progress";
}

/**
 * Partition runs into the 12b sidebar groups. Empty groups are kept so the UI
 * can decide whether to hide them; counts are always honest.
 */
export function groupTeamRuns(teams, seenAt = {}) {
  const groups = Object.fromEntries(TEAM_LIST_GROUPS.map((group) => [group.id, []]));
  for (const run of teams || []) {
    const id = teamListGroupId(run, seenAt);
    groups[id].push(run);
  }
  return groups;
}

/**
 * One short meta line under a sidebar title — title + status dot + this.
 *
 * Mockup 12b: no progress bars, no token counts. Needs-you says so; in-progress
 * may show a sub-task fraction; queued / merge / finished stay status-only.
 */
export function teamListMeta(run, groupId = null) {
  const group = groupId || teamListGroupId(run);
  if (group === "needs_you") {
    return "Needs you";
  }
  if (group === "in_progress") {
    const progress = teamRunProgress(run);
    if (progress.total) {
      return `${progress.done}/${progress.total}`;
    }
    // A paused run is not mid-phase — the phase label would claim a review (or
    // a build) is still running when a halt or the user stopped it (criterion 6).
    if (run?.status === "paused") {
      return teamStatusLabel(run?.status);
    }
    return teamPhaseLabel(run?.phase) || teamStatusLabel(run?.status);
  }
  if (group === "queued") {
    return "Queued";
  }
  if (group === "pending_merge") {
    return "Ready to merge";
  }
  return teamStatusLabel(run?.status);
}
