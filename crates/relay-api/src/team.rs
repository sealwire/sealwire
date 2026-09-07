//! Task team runner model.
//!
//! A `TeamRun` is one execution of the fixed three-role team — TL, dev, reviewer
//! — against a user-written `TaskSpec`, inside a dedicated git worktree. It holds
//! only orchestration metadata: every agent's real output lives in the background
//! thread it names, and the TL's plan/design/report live as files in the worktree.
//!
//! Two things here differ from `WorkflowRun` on purpose, and both are load-bearing:
//!
//! 1. **`TeamRunStatus` is its own enum, not `RunStatus`.** It has to carry
//!    `Paused`/`PausePending`/`AwaitingUser`, and adding a variant to the shared
//!    `RunStatus` would be a persistence trap: an unknown status string is a hard
//!    serde error, `PersistenceStore::load` turns that into `Err`, and `AppState::new`
//!    responds by discarding the ENTIRE `session.json` — paired devices, projects,
//!    allowed roots and all. So this enum decodes leniently (unknown -> `Failed`),
//!    which is the property `RunStatus` is missing.
//!
//! 2. **`Paused` is durable and survives restore.** Every other non-terminal run in
//!    this codebase reconciles to `Interrupted` when its driver is lost, because a
//!    run persisted `Running` with no driver would strand its locks. A paused run is
//!    the deliberate case of exactly that, so the exemption lives inside
//!    `mark_interrupted_if_stranded` rather than in its callers — neither the restore
//!    path nor the lifeguard can then forget it.
//!
//! Resumability contract: `(phase, each sub-task's status + digested flag, the round
//! counters, the verdicts)` is sufficient to decide the next action, and the
//! driver derives that action from the record alone, which is what proves it.
//! The driver advances `phase` in the SAME write that records a step's result, so
//! a crash re-runs at most the last turn. See `markdown/task-team-design.md` §5.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    orchestration::{
        DriverProgress, OrchestrationBackendRef, TeamCommandJournal, TeamCommandKind,
        TeamCommandOutcome, TeamCommandRecord,
    },
    unix_now, WorkflowVerdict,
};

/// Hard ceiling on review rounds per sub-task. The product rule is "at most two
/// rounds, one is fine"; this clamps whatever a caller asks for.
pub const MAX_SUBTASK_REVIEW_ROUNDS: u32 = 2;
/// Same ceiling for the final MR gate.
pub const MAX_MR_ROUNDS: u32 = 2;
/// How many times the TL may be re-seeded before the run gives up. A re-seed loop
/// would otherwise burn tokens forever on a task the TL cannot hold.
pub const MAX_TL_GENERATIONS: usize = 8;

/// Lifecycle of a team run.
///
/// Terminal: `Done`, `Escalated`, `Failed`, `Interrupted`, `Cancelled`.
/// Non-terminal with a live driver: `Queued`, `Running`, `PausePending`,
/// `AwaitingUser`, `Resolving`.
/// Non-terminal WITHOUT a driver: `Paused` (durable, re-spawnable) and `Blocked`
/// (a stop could not be confirmed; keeps owning its threads until recovery).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunStatus {
    /// Recorded, driver not yet started.
    Queued,
    /// The driver is working through actions.
    Running,
    /// A pause was requested. The driver is alive and finishing the in-flight
    /// turn; it settles to `Paused` at the next step boundary.
    PausePending,
    /// Settled at a boundary with no driver alive. Survives restart verbatim and
    /// can be resumed from the record. THIS is the state the interrupt
    /// reconciliation must not touch.
    Paused,
    /// A dev or TL thread is parked on an `AskUserQuestion`. The turn is NOT
    /// stopped — it is blocked inside the provider's tool callback and continues
    /// the moment the answer lands.
    AwaitingUser,
    /// The MR gate approved and every sub-task landed. TERMINAL.
    Done,
    /// A round budget ran out somewhere; unresolved items are written out.
    /// TERMINAL.
    Escalated,
    /// A stop path could not confirm a file-mutating turn actually stopped.
    /// Non-terminal on purpose: the run keeps owning its threads and worktree
    /// until an explicit recovery.
    Blocked,
    /// An explicit recovery action is draining owned turns. Non-terminal so
    /// duplicate recoveries cannot drain the same threads twice.
    Resolving,
    /// The safe fallback: also what an unknown or missing persisted status
    /// decodes to, so a forward-compat state file can never strand a lock.
    /// TERMINAL.
    #[default]
    Failed,
    /// The driver was lost while non-terminal and the run was not paused.
    /// TERMINAL — the card offers a re-run.
    Interrupted,
    /// The user stopped the run. TERMINAL.
    Cancelled,
}

impl TeamRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::PausePending => "pause_pending",
            Self::Paused => "paused",
            Self::AwaitingUser => "awaiting_user",
            Self::Done => "done",
            Self::Escalated => "escalated",
            Self::Blocked => "blocked",
            Self::Resolving => "resolving",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Cancelled => "cancelled",
        }
    }

    /// Decode a persisted status, treating anything unrecognized as the safe
    /// terminal `Failed`. Unlike `RunStatus`, an unknown value here must never
    /// become a serde error — see the module docs for what that would cost.
    pub fn from_wire(raw: &str) -> Self {
        match raw {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "pause_pending" => Self::PausePending,
            "paused" => Self::Paused,
            "awaiting_user" => Self::AwaitingUser,
            "done" => Self::Done,
            "escalated" => Self::Escalated,
            "blocked" => Self::Blocked,
            "resolving" => Self::Resolving,
            "interrupted" => Self::Interrupted,
            "cancelled" => Self::Cancelled,
            _ => Self::Failed,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Escalated | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }

    /// Whether a driver can be spawned for this run as-is.
    pub fn is_resumable(self) -> bool {
        matches!(self, Self::Paused)
    }

    /// Whether a terminal run may be put back to work on its existing branch.
    ///
    /// `Interrupted` and `Failed` qualify when work is on disk but the driver
    /// stopped without a user verdict — a lost driver or a planning parse miss.
    pub fn is_reopenable(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Escalated | Self::Interrupted | Self::Failed
        )
    }

    /// Whether the run holds its threads and worktree with no driver entitled to
    /// move it. `Paused` waits for the user, `Blocked` for an explicit recovery,
    /// `Resolving` for the recovery already in progress.
    ///
    /// These states are writable only by a deliberate user action, never by a
    /// driver. That asymmetry is the point: a force stop settles `Paused` while
    /// the driver is still inside a turn, and moments later that driver observes
    /// its own turn vanish and tries to record a failure. Letting it through would
    /// turn every successful force stop into `Failed`.
    pub fn is_settled_without_driver(self) -> bool {
        matches!(self, Self::Paused | Self::Blocked | Self::Resolving)
    }
}

impl<'de> Deserialize<'de> for TeamRunStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // `Option<String>` rather than `String` so an explicit `null` degrades to
        // the safe default instead of failing the whole state file.
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(raw.as_deref().map(Self::from_wire).unwrap_or_default())
    }
}

/// Why a run settled into `Paused`. Machine-readable so a client can tell "you
/// paused this" apart from "a provider limit stopped it" apart from "the relay's
/// own mechanism settled it" without parsing `pause_reason` prose.
///
/// Decodes leniently to `User` for the same reason `TeamRunStatus` does (see the
/// module docs): an unrecognized value must degrade rather than fail the whole
/// state file, and `User` is the safest guess for data written before this type
/// existed at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPauseKind {
    /// A direct, synchronous user action settled it: Stop, Cancel-to-pause, or
    /// recovering a `Blocked` run.
    User,
    /// A provider terminal the run cannot continue past (a usage limit today)
    /// settled it.
    Provider,
    /// Settled at a boundary check rather than by a direct user action: the
    /// driver's own per-step settle after a graceful pause was requested, the
    /// relay reconciling a stranded pause at restart, or this crate's own
    /// pre-dispatch reviewer gate.
    Boundary,
}

impl TeamPauseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Provider => "provider",
            Self::Boundary => "boundary",
        }
    }

    fn from_wire(raw: &str) -> Self {
        match raw {
            "provider" => Self::Provider,
            "boundary" => Self::Boundary,
            _ => Self::User,
        }
    }
}

impl<'de> Deserialize<'de> for TeamPauseKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(raw.as_deref().map(Self::from_wire).unwrap_or(Self::User))
    }
}

/// What a user may do with a thread a task team owns.
///
/// One answer for every lock call site, rather than each guard inventing its own
/// notion of "busy". The asymmetry is the requirement: a person watching a parked
/// dev can read its transcript and answer its question card, but has no composer
/// on it and no per-agent stop — the only stop is the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamThreadGate {
    /// Not a team thread at all.
    Free,
    /// The team lead of a paused run: conversable, because that is where a user
    /// redirects the task before resuming it.
    TlWhilePaused,
    /// The run owns the next turn on this thread.
    Locked,
}

/// The user's Task, verbatim.
///
/// The team must never edit this: `agreed_scope` and `quality_rules` are the MR
/// gate's yardstick. Only the user and the Orchestrator may widen it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskSpec {
    pub title: String,
    pub context: String,
    pub acceptance_criteria: String,
    pub agreed_scope: String,
    pub quality_rules: String,
}

/// A field-by-field rewrite of the task definition. `None` keeps what is there.
///
/// Separate from `TaskSpec` so "keep it" and "make it empty" stay different
/// answers — a reopen that named one field must not blank the four it did not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskSpecUpdates {
    pub title: Option<String>,
    pub context: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub agreed_scope: Option<String>,
    pub quality_rules: Option<String>,
}

impl TaskSpecUpdates {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.context.is_none()
            && self.acceptance_criteria.is_none()
            && self.agreed_scope.is_none()
            && self.quality_rules.is_none()
    }

    /// Which fields this would rewrite, for the card to show before the user
    /// confirms. Approving a definition change you cannot see is not approval.
    pub fn changed_fields(&self) -> Vec<&'static str> {
        [
            ("title", self.title.is_some()),
            ("context", self.context.is_some()),
            ("acceptance criteria", self.acceptance_criteria.is_some()),
            ("agreed scope", self.agreed_scope.is_some()),
            ("quality rules", self.quality_rules.is_some()),
        ]
        .into_iter()
        .filter_map(|(name, present)| present.then_some(name))
        .collect()
    }
}

impl TaskSpec {
    /// Rewrite the named fields for a new cycle.
    ///
    /// REPLACES, where `widen_scope` appends — and the difference is the point.
    /// An investigation's "change no code" has to be able to BECOME "change the
    /// code"; appending would leave both on the page and the reviewer picking.
    pub fn apply_updates(&mut self, updates: &TaskSpecUpdates) -> bool {
        let mut changed = false;
        for (field, value) in [
            (&mut self.title, &updates.title),
            (&mut self.context, &updates.context),
            (&mut self.acceptance_criteria, &updates.acceptance_criteria),
            (&mut self.agreed_scope, &updates.agreed_scope),
            (&mut self.quality_rules, &updates.quality_rules),
        ] {
            if let Some(replacement) = value {
                *field = replacement.clone();
                changed = true;
            }
        }
        changed
    }

    /// Append to the scope the MR gate measures against. Appends rather than
    /// replaces so the original ask stays readable next to what was added.
    pub fn widen_scope(&mut self, addition: &str) -> bool {
        let addition = addition.trim();
        if addition.is_empty() {
            return false;
        }
        if self.agreed_scope.trim().is_empty() {
            self.agreed_scope = addition.to_string();
        } else {
            self.agreed_scope = format!("{}\n\nAlso in scope: {addition}", self.agreed_scope);
        }
        true
    }
}

#[cfg(test)]
mod task_spec_tests {
    use super::TaskSpec;

    #[test]
    fn widening_keeps_the_original_ask_readable() {
        let mut spec = TaskSpec {
            agreed_scope: "Parser only.".to_string(),
            ..Default::default()
        };
        assert!(spec.widen_scope("Also the loader."));
        assert!(spec.agreed_scope.contains("Parser only."));
        assert!(spec.agreed_scope.contains("Also the loader."));
    }

    #[test]
    fn widening_with_nothing_changes_nothing() {
        let mut spec = TaskSpec {
            agreed_scope: "Parser only.".to_string(),
            ..Default::default()
        };
        assert!(!spec.widen_scope("   "));
        assert_eq!(spec.agreed_scope, "Parser only.");
    }

    #[test]
    fn widening_an_empty_scope_does_not_prefix_it() {
        let mut spec = TaskSpec::default();
        assert!(spec.widen_scope("The loader."));
        assert_eq!(spec.agreed_scope, "The loader.");
    }
}

/// Where the run is in the fixed pipeline.
///
/// Decodes leniently for the same reason `TeamRunStatus` does — a strict derive
/// here would make one unknown value from a newer build fail the whole
/// `PersistedRelayState` decode, which `AppState::new` answers by discarding the
/// entire session file. Unknown maps to `Finished`, the one variant that yields
/// no action at all: a record we cannot interpret must not be acted on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPhase {
    /// TL reads the spec, writes the plan file, and judges complexity.
    #[default]
    Intake,
    /// TL writes a design (complex tasks only).
    Design,
    /// The reviewer reviews the design.
    DesignReview,
    /// TL splits the work into sub-tasks.
    Planning,
    /// The dev/review loop, one sub-task at a time.
    SubTasks,
    /// Whole-diff review against the agreed scope and quality rules.
    MrGate,
    /// Final commit + report.
    Wrapping,
    Finished,
}

impl TeamPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Intake => "intake",
            Self::Design => "design",
            Self::DesignReview => "design_review",
            Self::Planning => "planning",
            Self::SubTasks => "sub_tasks",
            Self::MrGate => "mr_gate",
            Self::Wrapping => "wrapping",
            Self::Finished => "finished",
        }
    }

    fn from_wire(raw: &str) -> Self {
        match raw {
            "intake" => Self::Intake,
            "design" => Self::Design,
            "design_review" => Self::DesignReview,
            "planning" => Self::Planning,
            "sub_tasks" => Self::SubTasks,
            "mr_gate" => Self::MrGate,
            "wrapping" => Self::Wrapping,
            _ => Self::Finished,
        }
    }
}

impl<'de> Deserialize<'de> for TeamPhase {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        Ok(raw.as_deref().map(Self::from_wire).unwrap_or_default())
    }
}

/// Per-sub-task lifecycle. Terminal: `Done`, `Escalated`, `Failed`, `Skipped`,
/// `Superseded`.
///
/// Decodes leniently, same rationale as `TeamPhase`. Unknown maps to the terminal
/// `Failed`: a sub-task we cannot interpret is never re-run, and still gets
/// reported to the TL.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubTaskStatus {
    /// Needs a dev turn (round 1, or a further round after findings).
    #[default]
    Pending,
    /// The dev turn landed; needs a review turn.
    Implementing,
    /// The reviewer approved. TERMINAL.
    Done,
    /// The round budget ran out without approval. TERMINAL.
    Escalated,
    /// The step errored. TERMINAL.
    Failed,
    /// Never run because the run settled first. TERMINAL.
    Skipped,
    /// Replaced by a later plan, and still rerunnable by its id. TERMINAL.
    Superseded,
}

impl SubTaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Implementing => "implementing",
            Self::Done => "done",
            Self::Escalated => "escalated",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Superseded => "superseded",
        }
    }

    fn from_wire(raw: &str) -> Self {
        match raw {
            "pending" => Self::Pending,
            "implementing" => Self::Implementing,
            "done" => Self::Done,
            "escalated" => Self::Escalated,
            "skipped" => Self::Skipped,
            "superseded" => Self::Superseded,
            _ => Self::Failed,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Escalated | Self::Failed | Self::Skipped | Self::Superseded
        )
    }
}

impl<'de> Deserialize<'de> for SubTaskStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<String>::deserialize(deserializer)?;
        // A missing value means "not started", which is what `Pending` is; only an
        // UNKNOWN value is the untrustworthy case that must settle terminal.
        Ok(raw.as_deref().map_or(Self::Pending, Self::from_wire))
    }
}

/// A sub-task id `st-<hex>`, distinct for as long as this relay process runs.
/// A restart could in principle reissue one, and we accept that.
pub fn mint_sub_task_id() -> String {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    format!("st-{:x}", mint_number(&LAST, now))
}

/// `max(now, previous + 1)`, claimed atomically, because two reads of the clock
/// can land on the same nanosecond.
fn mint_number(last: &AtomicU64, now: u64) -> u64 {
    let mut minted = now;
    // Contention re-runs the closure, so the value it wrote last is the one this
    // call actually stored.
    let _ = last.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |prev| {
        minted = now.max(prev + 1);
        Some(minted)
    });
    minted
}

/// One TL-authored unit of work.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SubTask {
    pub id: String,
    pub title: String,
    /// TL-authored and SELF-CONTAINED: each sub-task brief must stand alone for
    /// the dev, though sub-tasks may share one session when `dev_agents` is 1.
    pub brief: String,
    pub status: SubTaskStatus,
    pub rounds_used: u32,
    /// How many times a rerun has revived this. A retry rejects the attempt the
    /// old session holds, so it never shares one — not even with its group.
    #[serde(default)]
    pub reruns: u32,
    /// Checkpoint commit taken when this sub-task started; scopes its review diff
    /// to its OWN changes rather than everything since the run began.
    pub base_commit: String,
    /// HEAD when this sub-task's current developer round started. A reviewer may
    /// only run after HEAD advances past this value, proving the developer
    /// produced a committed candidate for the round.
    #[serde(default)]
    pub round_base_sha: String,
    /// HEAD chosen as this sub-task's latest committed review candidate.
    #[serde(default)]
    pub candidate_sha: String,
    /// Candidate commit that the latest approving verdict reviewed.
    #[serde(default)]
    pub verdict_candidate_sha: String,
    /// Stale approving reviews already rebound for this candidate cycle.
    #[serde(default)]
    pub stale_review_retries: u32,
    pub dev_thread_id: Option<String>,
    pub reviewer_thread_id: Option<String>,
    /// Every thread this sub-task has ever owned — the set the lifeguard drains
    /// and the lock predicate consults. Never pruned while the run is live.
    pub owned_thread_ids: Vec<String>,
    pub last_verdict: Option<WorkflowVerdict>,
    /// The ONLY thing that reaches the TL. Never a transcript.
    pub result_summary: Option<String>,
    /// Whether the TL has been told this sub-task's outcome. Separate from
    /// `status` because settling and reporting are two different steps, and a
    /// crash between them must not lose the report.
    pub digested: bool,
    pub error: Option<String>,
    /// Legacy landed-work counter kept for existing persisted state and
    /// diagnostics. The current reviewer gate is the committed candidate pair:
    /// `candidate_sha` must be nonempty and differ from `round_base_sha`.
    #[serde(default)]
    pub dev_turns_landed: u32,
    /// Which reopen cycle is WORKING this sub-task, from `reopened_count`.
    ///
    /// A reopen keeps the last cycle's finished sub-tasks, so status alone cannot
    /// say whose work a session holds. Legacy 0 costs sharing, not correctness.
    #[serde(default)]
    pub cycle: u32,
}

/// Replay payload for one `TakeUserNotes` command. See the field doc on
/// `TeamRun::drained_notes`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LastDrainedNotes {
    pub command_id: String,
    pub notes: Vec<String>,
}

/// One TL session in the succession chain.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TlGeneration {
    pub thread_id: String,
    pub reason: String,
    pub retired_at: u64,
}

/// A parked question waiting on the user.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AwaitingUser {
    pub thread_id: String,
    pub request_id: String,
    /// `tl` or `dev` — the reviewer never asks.
    pub role: String,
    pub asked_at: u64,
}

/// WHERE in the record a thread id lives.
///
/// The driver addresses seats by slot rather than by value so it can re-resolve
/// after a mid-turn promotion. Holding the id itself is exactly the bug: the
/// value it captured before sending can be dead by the time the turn ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamThreadSlot {
    Tl,
    SubTaskDev(usize),
    SubTaskReviewer(usize),
    /// Index into `run_owned_thread_ids` — the design reviewer or an MR reviewer.
    RunOwned(usize),
    /// The dev seat that addresses MR-gate findings, wherever it came from.
    ///
    /// Named, not indexed: `run_owned_thread_ids` keeps every dead seat, so
    /// picking "the dev in it" reaches a session from two cycles ago.
    MrDev,
}

/// One seat in the task-team runtime.
///
/// This is mechanism vocabulary, not a workflow decision: the private engine
/// decides when and why a seat runs, while the public relay uses the role only
/// to choose the provider sandbox and approval policy for the thread it starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamRole {
    Tl,
    Dev,
    Reviewer,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tl => "tl",
            Self::Dev => "dev",
            Self::Reviewer => "reviewer",
        }
    }
}

/// What the public thread runtime observed after driving one team turn.
///
/// The distinction between `Failed` and `Blocked` is load-bearing: `Blocked`
/// means a turn may still be mutating the worktree, so the private driver must
/// not settle the run and release its locks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamTurnOutcome {
    Replied(String),
    Silent,
    Failed(String),
    Blocked(String),
    /// An approving reviewer inspected a candidate that no longer equals HEAD.
    /// The public relay has rebound the candidate; the private driver should
    /// re-review it directly without interpreting the stale approval as findings.
    ReviewStale(String),
}

/// Identity of the fixed three-seat pipeline that ships today (TL / Dev /
/// Reviewer). Configurable teams will add user-defined rows beside this; until
/// then every new [`TeamRun`] pins these ids so the token ledger's `team_id`
/// is populated rather than always `NULL`.
pub const BUILTIN_TEAM_ID: &str = "builtin";
/// Immutable version of [`BUILTIN_TEAM_ID`]. A live run must keep this pin for
/// its whole life — see `orchestrator-teams-budget-design.md` §6.3.
pub const BUILTIN_TEAM_VERSION_ID: &str = "builtin-v1";
/// Display name for the builtin team. Not persisted on the run; the catalog
/// (when it lands) is the source of truth for names.
pub const BUILTIN_TEAM_NAME: &str = "Default";

/// One execution of the team pipeline.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TeamRun {
    pub id: String,
    pub status: TeamRunStatus,
    pub phase: TeamPhase,
    pub spec: TaskSpec,
    pub sub_tasks: Vec<SubTask>,

    /// Immutable orchestration backend selected for this run.
    ///
    /// Existing and current T1-T3 runs default to `LegacyEmbedded`. Future Cloud
    /// and local-sidecar runs may be decoded by this public model, but this relay
    /// build cannot drive them without the later transport/executor tasks.
    #[serde(default)]
    pub orchestration_backend: OrchestrationBackendRef,
    /// Durable cursor/progress counters for the future command journal. T1-T3
    /// persists them only; the live embedded driver is not migrated onto this
    /// bookkeeping yet.
    #[serde(default)]
    pub driver_progress: DriverProgress,
    /// Bounded, content-blind record of local commands applied or rejected
    /// against this run — see `orchestration::TeamCommandRecord` and
    /// `.sealwire/DESIGN.md` D2/D9. Deliberately NOT inside `driver_progress`:
    /// that type's hand-written `Deserialize` marks the whole thing malformed
    /// on any unrecognized field, which would make adding this key a one-way
    /// downgrade trap for an older build. Excluded from `team_run_view`, so a
    /// journal-only write does not churn `teams_revision()`.
    #[serde(default)]
    pub command_journal: TeamCommandJournal,
    /// Replay payload for `TeamStateCommand::TakeUserNotes`, kept off the
    /// (content-blind) journal because notes are prose — see
    /// `.sealwire/DESIGN.md` D8. One entry per *applied* drain, appended (not
    /// overwritten): AC-4 requires an identical redelivery to replay the same
    /// receipt even after a LATER, different drain has landed, which a single
    /// overwritten slot cannot do. Evicted in lockstep with `command_journal`
    /// — when a `TakeUserNotes` journal record is dropped, its matching entry
    /// here is dropped too — so this never outgrows the journal's own bound.
    /// Plain `String`/`Vec<String>` rather than the bounded `CommandId` type
    /// so a corrupt value decodes leniently like the rest of this struct
    /// instead of failing the whole record.
    #[serde(default)]
    pub drained_notes: Vec<LastDrainedNotes>,

    /// Named team this run belongs to. Written into the token ledger at spend
    /// time. `None` only for runs started before team identity existed.
    pub team_id: Option<String>,
    /// Immutable team definition this run is pinned to. Drivers must resolve
    /// roles through this id, never through a mutable "current version".
    pub team_version_id: Option<String>,

    /// Whether the TL judged the task complex enough to need a design phase.
    /// `None` until intake answers it.
    pub complex: Option<bool>,

    pub slug: String,
    pub branch: String,
    /// FULLY QUALIFIED (`refs/heads/main`). It is evaluated by `merge_base_with`
    /// inside the task worktree, where a relative expression like `HEAD` would
    /// resolve to the task's own tip and hide every commit from the MR diff.
    pub target_ref: String,
    pub base_commit: String,
    pub repo_main_worktree: String,
    /// The worktree. Every team thread starts here, with this exact string.
    pub cwd: String,
    pub source_dirty: bool,

    pub plan_rel_path: String,
    pub design_rel_path: String,
    pub report_rel_path: String,

    pub tl_thread_id: String,
    pub tl_provider: String,
    pub tl_model: String,
    /// Reasoning effort for this seat. Empty means "the model's own default",
    /// which is not a level we could name on its behalf. `#[serde(default)]`
    /// keeps runs written before per-seat effort existed loadable.
    #[serde(default)]
    pub tl_effort: String,
    pub tl_succession: Vec<TlGeneration>,
    pub tl_turns_this_generation: u32,
    /// Why the team lead should be replaced before the next action, if it should.
    ///
    /// A single `Option<String>` rather than a flag plus a reason: the two can
    /// never disagree, and it decodes leniently by default so it is not another
    /// persisted enum to get wrong. Set proactively by the driver's budget check,
    /// reactively by a context-window failure, and at boot by
    /// `validate_paused_team_runs` when the recorded session no longer routes to
    /// any provider. Cleared by the re-seed that acts on it.
    pub tl_reseed_reason: Option<String>,

    /// Authoritative provider ownership captured when each seat is created.
    ///
    /// Role-level provider fields describe current team configuration; they are
    /// not enough for historical seats after reassignment. Older persisted runs
    /// decode with an empty map; deletion may use only confident legacy role
    /// mappings and otherwise fails closed.
    #[serde(default)]
    pub owned_thread_providers: BTreeMap<String, String>,

    /// Threads owned by the RUN rather than by a sub-task: the design reviewer,
    /// each MR-gate reviewer, and the dev thread that addresses MR findings.
    ///
    /// Without this they would have nowhere to live, and `owned_thread_ids` — the
    /// set the lifeguards drain and the lock predicate consults — would silently
    /// omit them. A cancel during the MR gate would then leave an orphaned turn,
    /// and for the MR-revision dev that turn keeps WRITING the worktree after the
    /// run's locks are released. Persisted, appended, never pruned while live.
    pub run_owned_thread_ids: Vec<String>,

    /// The seat each run-owned thread was started as. Recorded where the seat is
    /// still known, so its spend does not land in the report under no role.
    #[serde(default)]
    pub run_owned_thread_roles: BTreeMap<String, String>,

    /// The dev session that last addressed MR-gate findings, if there is one.
    ///
    /// Remembered rather than derived, because `run_owned_thread_ids` would
    /// answer with the oldest. Kept across a reopen: same code, same session.
    #[serde(default)]
    pub mr_dev_thread_id: Option<String>,

    /// Instructions left for the team to pick up on its next turn. The driver
    /// drains these; they are notes TO the team, never from it.
    #[serde(default)]
    pub pending_user_notes: Vec<String>,

    /// How many times a finished run was reopened. Kept so "Done" stays
    /// readable as a fact about a moment rather than about the run forever.
    #[serde(default)]
    pub reopened_count: u32,

    pub dev_provider: String,
    pub dev_model: String,
    #[serde(default)]
    pub dev_effort: String,
    pub reviewer_provider: String,
    pub reviewer_model: String,
    #[serde(default)]
    pub reviewer_effort: String,

    /// How many dev sessions the sub-tasks may be spread over, if the user said.
    /// `None` is one shared session (default). Clamped to `[1, sub_tasks]` once
    /// the TL has planned; set to the sub-task count for one session each.
    #[serde(default)]
    pub dev_agents: Option<u32>,

    pub max_review_rounds: u32,
    pub max_mr_rounds: u32,
    pub design_review_rounds: u32,
    pub mr_rounds_used: u32,
    /// HEAD when the current MR-correction developer round started.
    #[serde(default)]
    pub mr_round_base_sha: String,
    /// HEAD chosen as the latest committed MR-review candidate.
    #[serde(default)]
    pub mr_candidate_sha: String,
    /// Candidate commit that the latest approving MR verdict reviewed.
    #[serde(default)]
    pub mr_verdict_candidate_sha: String,
    /// Stale approving MR reviews already rebound for this candidate cycle.
    #[serde(default)]
    pub mr_stale_review_retries: u32,
    /// Prior final-gate findings carried to replacement/fresh reviewers after a
    /// committed correction. The latest `mr_verdict` is cleared between rounds,
    /// so this durable context keeps the negotiation from restarting.
    #[serde(default)]
    pub mr_review_context: Vec<String>,

    /// The thread a turn is being started on RIGHT NOW, set before the provider
    /// call and cleared once the turn resolves.
    ///
    /// Exists because a provider marks a thread working only AFTER `start_turn`
    /// returns: in between, the provider may already be running while relay state
    /// still reads idle. A driver lost in that window would look drained, the run
    /// would go terminal, its locks would release, and the real session would keep
    /// writing the worktree. This marker makes that window visible to cleanup.
    pub in_flight_thread: Option<String>,

    pub pause_requested: bool,
    /// Whether a stop is DRAINING this run's turns right now.
    ///
    /// Distinct from `pause_requested`, and the distinction is load-bearing. A
    /// graceful pause stops nothing, so a turn that fails during one failed on its
    /// own and the run really did fail. A stop KILLS the turn the driver is
    /// waiting on, so the failure it then reports is an artefact of the stop and
    /// must not become the run's verdict. Conflating the two strands a gracefully
    /// paused run in `PausePending` with no driver left to settle it.
    pub stopping: bool,
    pub pause_requested_by: String,
    pub pause_reason: Option<String>,
    /// Machine-readable companion to `pause_reason` — see [`TeamPauseKind`].
    /// `None` until the first pause this run ever takes; cleared by `resume`,
    /// same as `pause_reason`.
    #[serde(default)]
    pub pause_kind: Option<TeamPauseKind>,
    pub awaiting: Option<AwaitingUser>,

    pub design_verdict: Option<WorkflowVerdict>,
    pub mr_verdict: Option<WorkflowVerdict>,
    pub unresolved: Vec<String>,
    pub head_commit: Option<String>,

    pub requested_by_device_id: String,
    pub requested_at: u64,
    pub updated_at: u64,
    pub error: Option<String>,
}

impl TeamRun {
    pub fn new(id: String, spec: TaskSpec, cwd: String, requested_by_device_id: String) -> Self {
        let now = unix_now();
        Self {
            id,
            status: TeamRunStatus::Queued,
            phase: TeamPhase::Intake,
            spec,
            cwd,
            max_review_rounds: MAX_SUBTASK_REVIEW_ROUNDS,
            max_mr_rounds: MAX_MR_ROUNDS,
            requested_by_device_id,
            requested_at: now,
            updated_at: now,
            ..Self::default()
        }
    }

    /// Whether execution has begun in any observable way.
    ///
    /// Backend selection must happen before this flips. The predicate is wider
    /// than `status != Queued` because old or hand-written records may be missing
    /// one field while already naming threads, sub-tasks, progress, or results.
    pub fn orchestration_execution_started(&self) -> bool {
        self.status != TeamRunStatus::Queued
            || self.phase != TeamPhase::Intake
            || !self.tl_thread_id.is_empty()
            || !self.tl_succession.is_empty()
            || !self.run_owned_thread_ids.is_empty()
            || !self.owned_thread_providers.is_empty()
            || self.mr_dev_thread_id.is_some()
            || !self.sub_tasks.is_empty()
            || self.driver_progress.state_revision != 0
            || self.driver_progress.last_command_seq != 0
            || self.driver_progress.last_event_seq != 0
            || self.driver_progress.in_flight_command_id.is_some()
            || self.driver_progress.is_malformed()
            || !self.command_journal.is_empty()
            || self.complex.is_some()
            || self.design_verdict.is_some()
            || self.mr_verdict.is_some()
            || !self.unresolved.is_empty()
            || self.head_commit.is_some()
            || self.awaiting.is_some()
            || self.pause_requested
            || self.stopping
            || self.error.is_some()
    }

    /// Select the run backend before execution begins.
    pub fn set_orchestration_backend(
        &mut self,
        backend: OrchestrationBackendRef,
    ) -> Result<bool, &'static str> {
        if self.orchestration_backend == backend {
            return Ok(false);
        }
        if self.orchestration_execution_started() {
            return Err("orchestration backend cannot change after execution begins");
        }
        self.orchestration_backend = backend;
        self.updated_at = unix_now();
        Ok(true)
    }

    pub fn is_executable_by_current_build(&self) -> bool {
        self.orchestration_backend.is_executable_by_current_build()
    }

    pub fn is_live_in_current_build(&self) -> bool {
        self.is_executable_by_current_build() && !self.status.is_terminal()
    }

    pub fn non_executing_backend_reason(&self) -> Option<&'static str> {
        self.orchestration_backend.non_executing_reason()
    }

    /// Reconcile a run whose driver is gone after process restart.
    ///
    /// The restore path has no live driver left to finish a transition. Paused
    /// runs stay paused; pause-settling and parked-question runs land in a
    /// recoverable pause; executable legacy runs that were otherwise active are
    /// interrupted; unsupported backend records that were otherwise active fail
    /// closed while preserving their backend pin and prior diagnostics.
    pub fn reconcile_after_restore(&mut self) -> bool {
        let in_flight_recovered = self.recover_stranded_in_flight_command();
        self.reconcile_lifecycle_after_restore() || in_flight_recovered
    }

    /// D10: a run loaded with `driver_progress.in_flight_command_id` set gets
    /// a terminal `Interrupted` journal record for that id before anything
    /// else runs, and the field cleared. T4's own reducer never leaves one in
    /// flight, so this recovers state left by a future async executor, not
    /// anything this build produces. `fingerprint: None` (D10-corrected) means
    /// "match any digest": the original envelope was never durably recorded,
    /// so there is no real fingerprint to compare against, and inventing a
    /// sentinel value would make a genuine redelivery mismatch it and read as
    /// `DuplicateCommand` instead of replaying this `Interrupted` receipt.
    fn recover_stranded_in_flight_command(&mut self) -> bool {
        let Some(command_id) = self.driver_progress.in_flight_command_id.take() else {
            return false;
        };
        self.command_journal.push(TeamCommandRecord {
            command_id,
            sequence: self.driver_progress.last_command_seq,
            kind: TeamCommandKind::Unknown,
            fingerprint: None,
            expected_revision: self.driver_progress.state_revision,
            state_revision: self.driver_progress.state_revision,
            last_event_seq: self.driver_progress.last_event_seq,
            outcome: TeamCommandOutcome::Interrupted,
        });
        true
    }

    fn reconcile_lifecycle_after_restore(&mut self) -> bool {
        if self.status.is_terminal() {
            return false;
        }

        let settled_before = (
            self.pause_requested,
            self.stopping,
            self.awaiting.clone(),
            self.error.clone(),
        );
        if let Some(reason) = self.non_executing_backend_reason() {
            self.append_restore_error(reason);
        }

        match self.status {
            TeamRunStatus::Paused => {
                self.pause_requested = false;
                self.stopping = false;
                self.awaiting = None;
                let changed = settled_before
                    != (
                        self.pause_requested,
                        self.stopping,
                        self.awaiting.clone(),
                        self.error.clone(),
                    );
                if changed {
                    self.updated_at = unix_now();
                }
                changed
            }
            TeamRunStatus::PausePending => {
                self.settle_paused(
                    "the relay restarted while the team was pausing",
                    TeamPauseKind::Boundary,
                );
                true
            }
            TeamRunStatus::AwaitingUser => {
                self.rollback_current_round();
                self.settle_paused(
                    "the relay restarted while the team was waiting on your answer; that step will be re-run",
                    TeamPauseKind::Boundary,
                );
                true
            }
            _ if self.is_executable_by_current_build() => self.mark_interrupted_if_stranded(),
            _ => {
                self.pause_requested = false;
                self.stopping = false;
                self.awaiting = None;
                self.status = TeamRunStatus::Failed;
                self.updated_at = unix_now();
                true
            }
        }
    }

    fn append_restore_error(&mut self, reason: &str) {
        match self.error.as_mut() {
            Some(error) if error.contains(reason) => {}
            Some(error) if error.trim().is_empty() => {
                *error = reason.to_string();
            }
            Some(error) => {
                error.push_str("; ");
                error.push_str(reason);
            }
            None => {
                self.error = Some(reason.to_string());
            }
        }
    }

    /// Advance the status. Terminal is final, and a state the user settled is
    /// off-limits, so a decision that won a race can never be clobbered by the
    /// driver's next between-step write. Same guard `WorkflowRun` uses, widened by
    /// `Paused` because this run type is the one that can be settled underneath a
    /// live driver.
    pub fn set_status(&mut self, status: TeamRunStatus) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.error = Some(error.into());
        // A stop that is DRAINING outranks the failure it just caused. Killing a
        // turn makes the driver see it end with no reply, and between
        // `request_stop` and the settlement the run is `PausePending` — neither
        // terminal nor settled-without-driver — so the driver would win that race
        // and the user would get `failed` for pressing Cancel. The reason is still
        // recorded above; it is just not the run's verdict.
        //
        // Only while DRAINING. A graceful pause stops nothing, so a failure during
        // one is the run's own, and suppressing it there would leave a driverless
        // `PausePending` that blocks every future task and that Resume refuses.
        if self.stopping {
            self.updated_at = unix_now();
            return;
        }
        self.set_status(TeamRunStatus::Failed);
    }

    pub fn block(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.stopping = false;
        self.status = TeamRunStatus::Blocked;
        self.updated_at = unix_now();
    }

    /// Record a pause request. Does not stop anything: the driver settles at the
    /// next boundary.
    pub fn request_pause(&mut self, device_id: impl Into<String>) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.pause_requested = true;
        self.pause_requested_by = device_id.into();
        self.set_status(TeamRunStatus::PausePending);
    }

    /// Record a stop that is about to drain this run's turns.
    ///
    /// Everything `request_pause` does, plus the marker that says the failures
    /// about to arrive were CAUSED by us.
    pub fn request_stop(&mut self, device_id: impl Into<String>) {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return;
        }
        self.request_pause(device_id);
        self.stopping = true;
        self.updated_at = unix_now();
    }

    /// Settle a requested pause. Returns whether it took.
    pub fn settle_paused(&mut self, reason: impl Into<String>, kind: TeamPauseKind) -> bool {
        if self.status.is_terminal() || self.status.is_settled_without_driver() {
            return false;
        }
        self.pause_requested = false;
        self.stopping = false;
        self.pause_reason = Some(reason.into());
        self.pause_kind = Some(kind);
        // Nothing is in flight once a pause settles: the caller proved every owned
        // turn is quiescent before getting here. Leaving a stale marker would make
        // the next cleanup pass read an unobservable turn and block the run.
        self.in_flight_thread = None;
        // Nor is anyone still being asked. Proving quiescence means the turn that
        // raised the question was stopped and its pending entry cleared, so a
        // surviving `awaiting` would render a card for a question that is gone.
        self.awaiting = None;
        self.status = TeamRunStatus::Paused;
        self.updated_at = unix_now();
        true
    }

    /// Ask for a fresh team lead before the next action. Idempotent — the FIRST
    /// reason wins, because it is the one that actually diagnosed the problem.
    pub fn request_tl_reseed(&mut self, reason: impl Into<String>) {
        if self.tl_reseed_reason.is_some() {
            return;
        }
        self.tl_reseed_reason = Some(reason.into());
        self.updated_at = unix_now();
    }

    /// How many team leads this run has had, including the current one.
    pub fn tl_generation_count(&self) -> usize {
        self.tl_succession.len() + 1
    }

    /// Retire the current team lead so a fresh one can take over.
    ///
    /// Returns false when the succession chain is already at its cap: a re-seed
    /// loop would otherwise burn tokens forever on a task no team lead can hold.
    ///
    /// The old thread is NEVER deleted. It is the audit trail for everything that
    /// generation decided, it stays in `owned_thread_ids` so a drain still reaches
    /// it, and the plan file on disk — not the session — is what the successor
    /// actually inherits.
    pub fn retire_tl(&mut self, reason: impl Into<String>) -> bool {
        if self.tl_generation_count() >= MAX_TL_GENERATIONS {
            return false;
        }
        let reason = reason.into();
        if !self.tl_thread_id.is_empty() {
            self.tl_succession.push(TlGeneration {
                thread_id: std::mem::take(&mut self.tl_thread_id),
                reason: reason.clone(),
                retired_at: unix_now(),
            });
        }
        self.tl_thread_id = String::new();
        self.tl_turns_this_generation = 0;
        self.tl_reseed_reason = None;
        self.updated_at = unix_now();
        true
    }

    /// Leave `Paused` for a fresh drive. Returns whether it took.
    ///
    /// The ONLY way out of a settled state back into work, and deliberately
    /// narrow: `is_resumable` is `Paused` alone, so this can never restart a run
    /// that was cancelled, blocked, or is already being driven. Resume needs no
    /// cursor of its own — the driver reads its next action out of the record, so
    /// a resumed driver and a cold one take exactly the same path.
    ///
    /// `error` is cleared because the only errors that reach a resumable run are
    /// the ones a recovery already dealt with; keeping one would leave a resumed
    /// task wearing a failure that is no longer true.
    pub fn resume(&mut self) -> bool {
        if !self.status.is_resumable() {
            return false;
        }
        self.pause_requested = false;
        self.stopping = false;
        self.pause_requested_by = String::new();
        self.pause_reason = None;
        self.pause_kind = None;
        self.error = None;
        self.status = TeamRunStatus::Running;
        self.updated_at = unix_now();
        true
    }

    /// Settle the run at the user's request. TERMINAL.
    ///
    /// Unlike `set_status` this may leave `Paused`/`Blocked`/`Resolving`: those
    /// states exist to stop a DRIVER from writing over a decision, not to stop the
    /// user from making one. Callers must confirm every owned turn stopped first —
    /// terminal releases the run's locks, and an agent still writing the worktree
    /// after that is exactly what `Blocked` exists to prevent.
    pub fn cancel(&mut self, reason: impl Into<String>) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.error = Some(reason.into());
        self.pause_requested = false;
        self.stopping = false;
        self.awaiting = None;
        self.in_flight_thread = None;
        self.status = TeamRunStatus::Cancelled;
        self.updated_at = unix_now();
        true
    }

    /// Relabel a run to `Done` or `Cancelled` regardless of its current status.
    ///
    /// Unlike [`set_status`] and [`cancel`], this is an explicit user/agent
    /// override: a terminal run can be dismissed or accepted without reopening
    /// it. Callers that still have a live driver must drain first.
    pub fn force_mark_status(&mut self, status: TeamRunStatus) -> bool {
        match status {
            TeamRunStatus::Done | TeamRunStatus::Cancelled => {}
            _ => return false,
        }
        if self.status == status {
            return false;
        }
        self.pause_requested = false;
        self.stopping = false;
        self.awaiting = None;
        self.in_flight_thread = None;
        self.pause_reason = None;
        self.pause_kind = None;
        if matches!(status, TeamRunStatus::Done) {
            self.error = None;
        } else if self.error.is_none() {
            self.error = Some("the task was marked cancelled".into());
        }
        self.status = status;
        self.updated_at = unix_now();
        true
    }

    /// `Blocked` -> `Resolving`. Only a blocked run may enter, so two concurrent
    /// recoveries cannot drain the same threads twice.
    pub fn begin_resolving_blocked(&mut self) -> bool {
        if !matches!(self.status, TeamRunStatus::Blocked) {
            return false;
        }
        self.status = TeamRunStatus::Resolving;
        self.updated_at = unix_now();
        true
    }

    /// `Resolving` -> `Paused`, once the recovery's drain confirmed.
    ///
    /// Deliberately NOT terminal, unlike `WorkflowRun::resolve_blocked_as_failed`.
    /// A drained team run is quiescent with its worktree and plan file intact,
    /// which is precisely what `Paused` describes — and the next action is a pure
    /// function of the record, so the work is genuinely resumable. Throwing
    /// that away would discard finished sub-tasks over a stop that took two tries.
    pub fn resolve_as_paused(&mut self, reason: impl Into<String>, kind: TeamPauseKind) -> bool {
        if !matches!(self.status, TeamRunStatus::Resolving) {
            return false;
        }
        self.pause_requested = false;
        self.stopping = false;
        self.pause_reason = Some(reason.into());
        self.pause_kind = Some(kind);
        self.in_flight_thread = None;
        self.status = TeamRunStatus::Paused;
        self.updated_at = unix_now();
        true
    }

    /// `Resolving` -> `Blocked`, for a recovery that never finished.
    pub fn restore_resolving_as_blocked(&mut self, error: impl Into<String>) -> bool {
        if !matches!(self.status, TeamRunStatus::Resolving) {
            return false;
        }
        self.block(error);
        true
    }

    /// Reconcile a run whose driver is gone. Returns whether it changed.
    ///
    /// A `Paused` run is exempt: it has no driver ON PURPOSE and must survive a
    /// restart verbatim so `resume_team_run` can pick it up. The exemption lives
    /// here rather than in the restore path and the lifeguard so neither can
    /// forget it.
    pub fn mark_interrupted_if_stranded(&mut self) -> bool {
        if self.status.is_terminal() || self.status.is_resumable() {
            return false;
        }
        self.error.get_or_insert_with(|| {
            "the task team's driver was lost; re-run to continue from the last completed step"
                .to_string()
        });
        self.status = TeamRunStatus::Interrupted;
        self.updated_at = unix_now();
        true
    }

    /// Snapshot this run as unresumable because its TL thread never materialized.
    ///
    /// Applied by the persistence writer, not to the live run: the in-memory run
    /// keeps going, and the next write (after the provider promotes the id)
    /// records the real state. What this protects is the RESTORE — a synthetic
    /// `claude-pending-*` id names nothing after a restart, so the run must come
    /// back terminal rather than as something the user can press Resume on. The
    /// spec, worktree path and branch are deliberately kept: a tree and a branch
    /// exist on disk, and a card that says so beats a card that vanished.
    pub fn detach_unresumable_tl(&mut self) {
        self.tl_thread_id = String::new();
        self.pause_requested = false;
        self.awaiting = None;
        if !self.status.is_terminal() {
            self.error.get_or_insert_with(|| {
                "the team lead's session had not started when the relay restarted; re-run this task"
                    .to_string()
            });
            self.status = TeamRunStatus::Interrupted;
            self.updated_at = unix_now();
        }
    }

    /// Roll the sub-task in flight back to the start of its current round.
    ///
    /// Used when a parked question can no longer be answered — pending questions
    /// live only in memory and the provider worker dies with the relay, so on
    /// restore there is nobody left to answer and nobody left to receive it.
    /// `rounds_used` is deliberately untouched: the round never completed, so
    /// charging it against the budget would silently shorten the team's runway.
    pub fn rollback_current_round(&mut self) {
        self.awaiting = None;
        let Some(index) = self.current_sub_task() else {
            return;
        };
        if let Some(task) = self.sub_tasks.get_mut(index) {
            if !task.status.is_terminal() {
                task.status = SubTaskStatus::Pending;
            }
        }
    }

    /// Put escalated sub-tasks back to work, because a user note is the user
    /// asking for another go. Returns whether anything was revived.
    ///
    /// Two things have to move together or the note still has nowhere to land.
    /// The per-cycle closure state goes with the revival — `finalize` refuses a
    /// run with `unresolved` entries, so leaving the old findings behind means a
    /// run that has since been fixed can never reach `Done`. And the phase has
    /// to come back to `SubTasks`: `next_team_action` only looks at sub-tasks
    /// there, so a run already at the gate walks straight past the revived one.
    ///
    /// A sub-task mid-round keeps its spent rounds — refunding work in flight
    /// would hand out budget nobody asked for.
    pub fn revive_escalated_sub_tasks(&mut self) -> bool {
        self.revive_sub_tasks(None)
    }

    /// [`revive_escalated_sub_tasks`] with a filter: `None` takes every
    /// `Escalated` sub-task, `Some(ids)` takes those ids where already terminal.
    ///
    /// The terminal guard lives here, not in the caller, so no future caller can
    /// reset a sub-task whose turn is still running and lose the work in flight.
    pub fn revive_sub_tasks(&mut self, only: Option<&[String]>) -> bool {
        let mut revived = false;
        // A revived sub-task is worked NOW, whatever cycle wrote it down; a
        // stale stamp hides its developer from the run's session topology.
        let working_cycle = self.reopened_count;
        for task in &mut self.sub_tasks {
            let selected = match only {
                None => task.status == SubTaskStatus::Escalated,
                Some(ids) => task.status.is_terminal() && ids.iter().any(|id| id == &task.id),
            };
            if selected {
                task.status = SubTaskStatus::Pending;
                task.rounds_used = 0;
                task.digested = false;
                // A revived attempt needs a fresh committed candidate; otherwise
                // the next reviewer could inherit the previous attempt's target.
                task.round_base_sha.clear();
                task.candidate_sha.clear();
                task.verdict_candidate_sha.clear();
                task.stale_review_retries = 0;
                task.dev_turns_landed = 0;
                // The session holds the attempt being rejected. Dropped from the
                // slot but left in `owned_thread_ids`: it still has to be drained.
                task.dev_thread_id = None;
                task.reruns += 1;
                task.cycle = working_cycle;
                revived = true;
            }
        }
        if !revived {
            return false;
        }
        self.design_review_rounds = 0;
        self.mr_rounds_used = 0;
        self.mr_round_base_sha.clear();
        self.mr_candidate_sha.clear();
        self.mr_verdict_candidate_sha.clear();
        self.mr_stale_review_retries = 0;
        self.unresolved.clear();
        self.mr_verdict = None;
        self.design_verdict = None;
        if matches!(self.phase, TeamPhase::MrGate | TeamPhase::Wrapping) {
            self.phase = TeamPhase::SubTasks;
        }
        self.updated_at = unix_now();
        true
    }

    /// Append the TL's new plan, retiring rather than dropping what it replaces,
    /// so an earlier sub-task's id still names its record and can be rerun.
    pub fn replan_sub_tasks(&mut self, planned: Vec<SubTask>) {
        for task in &mut self.sub_tasks {
            // Only what never finished. A reopened run replans with the last
            // cycle's outcomes in the list, and overwriting them loses the record.
            if !task.status.is_terminal() {
                task.status = SubTaskStatus::Superseded;
                // `current_sub_task` selects an undigested entry however terminal,
                // and the TL wrote the replan, so it is owed no report about it.
                task.digested = true;
            }
        }
        for mut task in planned {
            // A restart resets the mint, so a new id can land on a retained one and
            // leave that record unreachable by name. One re-mint is the defence.
            if self.sub_tasks.iter().any(|kept| kept.id == task.id) {
                task.id = mint_sub_task_id();
            }
            // The last cycle's finished sub-tasks stay in the list beside these,
            // and nothing else tells the two apart.
            task.cycle = self.reopened_count;
            self.sub_tasks.push(task);
        }
        self.updated_at = unix_now();
    }

    /// Pull the phase back to `SubTasks` while one is waiting, dropping the verdict
    /// and findings that judged the diff before it. Returns whether it moved.
    ///
    /// A driver picks its next phase before a turn and writes it when the turn ends,
    /// so a revival landing in between is invisible to that decision and buried by it.
    pub fn hold_phase_for_waiting_sub_tasks(&mut self) -> bool {
        let closing = matches!(
            self.phase,
            TeamPhase::MrGate | TeamPhase::Wrapping | TeamPhase::Finished
        );
        if !closing || self.current_sub_task().is_none() {
            return false;
        }
        self.phase = TeamPhase::SubTasks;
        self.mr_verdict = None;
        // Leftovers from that same turn would outlive the work that answers them,
        // and `finalize` refuses to call a run with leftovers Done.
        self.unresolved.clear();
        self.updated_at = unix_now();
        true
    }

    /// The sub-task the run is currently working, for display. Derived, so it can
    /// never drift from the sub-task statuses the way a stored cursor would.
    pub fn current_sub_task(&self) -> Option<usize> {
        self.sub_tasks
            .iter()
            .position(|task| !task.status.is_terminal() || !task.digested)
    }

    /// Rewrite every reference to `pending_id` as `real_id`.
    ///
    /// Claude mints a synthetic `claude-pending-*` id and only replaces it with a
    /// real session id once the first turn starts, at which point
    /// `promote_background_thread` re-keys the runtime map. EVERY seat here is
    /// background-started, so every one of them can be promoted mid-turn — and a
    /// driver still holding the pending id would find no runtime, read that as
    /// "not working", and treat a turn that is very much running as finished.
    pub fn rekey_thread(&mut self, pending_id: &str, real_id: &str) -> bool {
        if pending_id.is_empty() || pending_id == real_id {
            return false;
        }
        let mut changed = false;
        let mut swap = |slot: &mut String| {
            if slot == pending_id {
                *slot = real_id.to_string();
                changed = true;
            }
        };
        swap(&mut self.tl_thread_id);
        for generation in self.tl_succession.iter_mut() {
            swap(&mut generation.thread_id);
        }
        for thread_id in self.run_owned_thread_ids.iter_mut() {
            swap(thread_id);
        }
        if let Some(mr_dev) = self.mr_dev_thread_id.as_mut() {
            swap(mr_dev);
        }
        for task in self.sub_tasks.iter_mut() {
            if let Some(dev) = task.dev_thread_id.as_mut() {
                swap(dev);
            }
            if let Some(reviewer) = task.reviewer_thread_id.as_mut() {
                swap(reviewer);
            }
            for thread_id in task.owned_thread_ids.iter_mut() {
                swap(thread_id);
            }
        }
        // Left behind, the seat bills under no role and reads as one nobody
        // ever started.
        if let Some(role) = self.run_owned_thread_roles.remove(pending_id) {
            self.run_owned_thread_roles
                .insert(real_id.to_string(), role);
            changed = true;
        }
        if let Some(provider) = self.owned_thread_providers.remove(pending_id) {
            self.owned_thread_providers
                .insert(real_id.to_string(), provider);
            changed = true;
        }
        if let Some(in_flight) = self.in_flight_thread.as_mut() {
            if in_flight == pending_id {
                *in_flight = real_id.to_string();
                changed = true;
            }
        }
        if let Some(awaiting) = self.awaiting.as_mut() {
            if awaiting.thread_id == pending_id {
                awaiting.thread_id = real_id.to_string();
                changed = true;
            }
        }
        if changed {
            self.updated_at = unix_now();
        }
        changed
    }

    /// Read the CURRENT id in a seat, so a caller can re-resolve after a promotion
    /// instead of holding one it captured before the turn started.
    pub fn thread_in_slot(&self, slot: TeamThreadSlot) -> Option<String> {
        let id = match slot {
            TeamThreadSlot::Tl => self.tl_thread_id.clone(),
            TeamThreadSlot::SubTaskDev(index) => {
                self.sub_tasks.get(index)?.dev_thread_id.clone()?
            }
            TeamThreadSlot::SubTaskReviewer(index) => {
                self.sub_tasks.get(index)?.reviewer_thread_id.clone()?
            }
            TeamThreadSlot::RunOwned(index) => self.run_owned_thread_ids.get(index)?.clone(),
            TeamThreadSlot::MrDev => self.mr_dev_thread_id.clone()?,
        };
        (!id.is_empty()).then_some(id)
    }

    /// Record a thread the RUN owns (design reviewer, MR reviewer, MR-revision
    /// dev). Idempotent, so a retry cannot double-register.
    pub fn record_run_thread(&mut self, thread_id: impl Into<String>) {
        let thread_id = thread_id.into();
        if thread_id.is_empty() || self.run_owned_thread_ids.contains(&thread_id) {
            return;
        }
        self.run_owned_thread_ids.push(thread_id);
        self.updated_at = unix_now();
    }

    /// Tag a run-owned thread with the seat it was started as.
    pub fn record_run_thread_role(&mut self, thread_id: impl Into<String>, role: TeamRole) {
        let thread_id = thread_id.into();
        if thread_id.is_empty() {
            return;
        }
        self.run_owned_thread_roles
            .insert(thread_id, role.as_str().to_string());
        self.updated_at = unix_now();
    }

    /// Capture the bridge that actually created a seat. This stays attached to
    /// the thread id even if the run's role-level provider selection later
    /// changes.
    pub fn record_owned_thread_provider(
        &mut self,
        thread_id: impl Into<String>,
        provider: impl Into<String>,
    ) {
        let thread_id = thread_id.into();
        let provider = provider.into();
        if thread_id.is_empty() || provider.is_empty() {
            return;
        }
        self.owned_thread_providers.insert(thread_id, provider);
        self.updated_at = unix_now();
    }

    /// Every thread this run owns right now, deduplicated and in a stable order.
    ///
    /// Retired TL generations stay in the set: they should already be idle, but a
    /// drain that skipped them would be exactly the hole a re-seed opens. Same for
    /// run-level threads — the MR-revision dev writes files, so a drain that
    /// missed it would let the worktree keep changing after the locks are gone.
    pub fn owned_thread_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        let candidates = std::iter::once(self.tl_thread_id.as_str())
            .chain(
                self.tl_succession
                    .iter()
                    .map(|generation| generation.thread_id.as_str()),
            )
            .chain(self.run_owned_thread_ids.iter().map(String::as_str))
            // This seat WRITES, so a drain that missed it would keep changing
            // files after the run's locks were released.
            .chain(self.mr_dev_thread_id.as_deref())
            .chain(self.sub_tasks.iter().flat_map(|task| {
                task.owned_thread_ids
                    .iter()
                    .map(String::as_str)
                    .chain(task.dev_thread_id.as_deref())
                    .chain(task.reviewer_thread_id.as_deref())
            }));
        for id in candidates {
            if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_string());
            }
        }
        ids
    }

    /// Which provider bridge owns this seat, from the run record — not from the
    /// ephemeral thread list. Task deletion uses this so a seat older than the
    /// newest-200 scan is still reachable after a restart.
    ///
    /// Returns `None` when the record has neither an explicit seat → provider
    /// entry nor a confident legacy role mapping. Destructive callers must fail
    /// closed rather than guess: older runs can keep mixed-role ids in
    /// `run_owned_thread_ids` / `owned_thread_ids` while
    /// `run_owned_thread_roles` defaults empty.
    pub fn provider_for_owned_thread(&self, thread_id: &str) -> Option<&str> {
        if thread_id.is_empty() {
            return None;
        }
        fn named(provider: &str) -> Option<&str> {
            (!provider.is_empty()).then_some(provider)
        }
        if let Some(provider) = self.owned_thread_providers.get(thread_id) {
            return named(provider);
        }
        if self.tl_thread_id == thread_id
            || self
                .tl_succession
                .iter()
                .any(|generation| generation.thread_id == thread_id)
        {
            return named(&self.tl_provider);
        }
        if self.mr_dev_thread_id.as_deref() == Some(thread_id) {
            return named(&self.dev_provider);
        }
        if let Some(role) = self.run_owned_thread_roles.get(thread_id) {
            return match role.as_str() {
                "reviewer" => named(&self.reviewer_provider),
                // `TeamRole::Tl` persists as "tl"; accept legacy "lead" spellings.
                "tl" | "lead" => named(&self.tl_provider),
                "dev" => named(&self.dev_provider),
                _ => None,
            };
        }
        // Untagged run-owned seats (design/MR reviewers, etc.): role unknown.
        if self.run_owned_thread_ids.iter().any(|id| id == thread_id) {
            return None;
        }
        for task in &self.sub_tasks {
            if task.reviewer_thread_id.as_deref() == Some(thread_id) {
                return named(&self.reviewer_provider);
            }
            if task.dev_thread_id.as_deref() == Some(thread_id) {
                return named(&self.dev_provider);
            }
            // Historical `owned_thread_ids` can mix prior reviewers and devs.
            if task.owned_thread_ids.iter().any(|id| id == thread_id) {
                return None;
            }
        }
        None
    }

    /// Drop every reference to a seat that has already been permanently deleted.
    ///
    /// A partial task delete must leave durable progress on the run itself: the
    /// in-memory tombstone set is cleared on restore, so a retry that still named
    /// a deleted seat would hit a routing miss and stall forever.
    pub fn release_owned_thread(&mut self, thread_id: &str) {
        if thread_id.is_empty() {
            return;
        }
        let mut changed = false;
        if self.tl_thread_id == thread_id {
            self.tl_thread_id.clear();
            changed = true;
        }
        let before = self.tl_succession.len();
        self.tl_succession
            .retain(|generation| generation.thread_id != thread_id);
        changed |= self.tl_succession.len() != before;
        let before = self.run_owned_thread_ids.len();
        self.run_owned_thread_ids.retain(|id| id != thread_id);
        changed |= self.run_owned_thread_ids.len() != before;
        if self.run_owned_thread_roles.remove(thread_id).is_some() {
            changed = true;
        }
        if self.owned_thread_providers.remove(thread_id).is_some() {
            changed = true;
        }
        if self.mr_dev_thread_id.as_deref() == Some(thread_id) {
            self.mr_dev_thread_id = None;
            changed = true;
        }
        for task in &mut self.sub_tasks {
            if task.dev_thread_id.as_deref() == Some(thread_id) {
                task.dev_thread_id = None;
                changed = true;
            }
            if task.reviewer_thread_id.as_deref() == Some(thread_id) {
                task.reviewer_thread_id = None;
                changed = true;
            }
            let before = task.owned_thread_ids.len();
            task.owned_thread_ids.retain(|id| id != thread_id);
            changed |= task.owned_thread_ids.len() != before;
        }
        if changed {
            self.updated_at = unix_now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkflowVerdict;

    fn run_with(phase: TeamPhase, sub_tasks: Vec<SubTask>) -> TeamRun {
        let mut run = TeamRun::new(
            "run-1".to_string(),
            TaskSpec::default(),
            "/tmp/wt".to_string(),
            "device-1".to_string(),
        );
        run.status = TeamRunStatus::Running;
        run.phase = phase;
        run.sub_tasks = sub_tasks;
        run
    }

    fn sub_task(status: SubTaskStatus, digested: bool) -> SubTask {
        SubTask {
            id: "st".to_string(),
            status,
            digested,
            ..SubTask::default()
        }
    }

    #[test]
    fn unknown_status_decodes_to_failed_not_an_error() {
        // The whole reason this enum exists instead of reusing `RunStatus`: a
        // serde error here would make `PersistenceStore::load` fail, which makes
        // `AppState::new` discard the entire session file.
        let decoded: TeamRunStatus =
            serde_json::from_str("\"a_status_from_a_future_build\"").expect("must not error");
        assert_eq!(decoded, TeamRunStatus::Failed);

        let null: TeamRunStatus = serde_json::from_str("null").expect("null must not error");
        assert_eq!(null, TeamRunStatus::Failed);
    }

    #[test]
    fn known_statuses_round_trip() {
        for status in [
            TeamRunStatus::Queued,
            TeamRunStatus::Running,
            TeamRunStatus::PausePending,
            TeamRunStatus::Paused,
            TeamRunStatus::AwaitingUser,
            TeamRunStatus::Done,
            TeamRunStatus::Escalated,
            TeamRunStatus::Blocked,
            TeamRunStatus::Resolving,
            TeamRunStatus::Failed,
            TeamRunStatus::Interrupted,
            TeamRunStatus::Cancelled,
        ] {
            let encoded = serde_json::to_string(&status).expect("serialize");
            let decoded: TeamRunStatus = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, status, "round trip failed for {}", status.as_str());
            assert_eq!(encoded, format!("\"{}\"", status.as_str()));
        }
    }

    #[test]
    fn new_team_runs_are_legacy_embedded_with_empty_driver_progress() {
        let run = TeamRun::new(
            "r".to_string(),
            TaskSpec::default(),
            "/tmp/wt".to_string(),
            "device".to_string(),
        );
        assert_eq!(
            run.orchestration_backend,
            OrchestrationBackendRef::LegacyEmbedded
        );
        assert_eq!(run.driver_progress.state_revision, 0);
        assert_eq!(run.driver_progress.last_command_seq, 0);
        assert_eq!(run.driver_progress.last_event_seq, 0);
        assert!(run.driver_progress.in_flight_command_id.is_none());
    }

    #[test]
    fn legacy_json_defaults_to_legacy_embedded_backend() {
        let run: TeamRun = serde_json::from_str(r#"{"id":"r","status":"paused"}"#)
            .expect("legacy run must decode");
        assert_eq!(
            run.orchestration_backend,
            OrchestrationBackendRef::LegacyEmbedded
        );
        assert_eq!(run.driver_progress, Default::default());
    }

    #[test]
    fn current_build_liveness_is_executable_legacy_and_non_terminal() {
        let mut run = TeamRun::new(
            "r".to_string(),
            TaskSpec::default(),
            "/tmp/wt".to_string(),
            "device".to_string(),
        );
        for status in [
            TeamRunStatus::Queued,
            TeamRunStatus::Running,
            TeamRunStatus::PausePending,
            TeamRunStatus::Paused,
            TeamRunStatus::AwaitingUser,
            TeamRunStatus::Blocked,
            TeamRunStatus::Resolving,
        ] {
            run.status = status;
            assert!(run.is_executable_by_current_build(), "{status:?}");
            assert!(run.is_live_in_current_build(), "{status:?}");
        }
        for status in [
            TeamRunStatus::Done,
            TeamRunStatus::Escalated,
            TeamRunStatus::Failed,
            TeamRunStatus::Interrupted,
            TeamRunStatus::Cancelled,
        ] {
            run.status = status;
            assert!(run.is_executable_by_current_build(), "{status:?}");
            assert!(!run.is_live_in_current_build(), "{status:?}");
        }

        run.status = TeamRunStatus::Paused;
        run.orchestration_backend = OrchestrationBackendRef::Cloud {
            protocol_version: crate::orchestration::SupportedProtocolVersion::current(),
            driver_version: crate::orchestration::DriverVersion::new("driver.1").unwrap(),
            cloud_run_id: crate::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
        };
        assert!(!run.is_executable_by_current_build());
        assert!(!run.is_live_in_current_build());
    }

    #[test]
    fn explicit_malformed_backend_refs_become_non_executing() {
        for backend_json in ["null", "{}"] {
            let run: TeamRun = serde_json::from_str(&format!(
                r#"{{"id":"r","status":"paused","orchestration_backend":{backend_json}}}"#
            ))
            .expect("malformed backend ref must not drop the run");
            assert_eq!(
                run.orchestration_backend,
                OrchestrationBackendRef::unknown_non_executing(),
                "explicit malformed backend must fail closed: {backend_json}"
            );
        }
    }

    #[test]
    fn backend_can_only_change_before_execution_begins() {
        let mut run = TeamRun::new(
            "r".to_string(),
            TaskSpec::default(),
            "/tmp/wt".to_string(),
            "device".to_string(),
        );
        let cloud = OrchestrationBackendRef::Cloud {
            protocol_version: crate::orchestration::SupportedProtocolVersion::current(),
            driver_version: crate::orchestration::DriverVersion::new("driver.1").unwrap(),
            cloud_run_id: crate::orchestration::DriverRunId::new("cloud-run-1").unwrap(),
        };
        assert!(run.set_orchestration_backend(cloud.clone()).unwrap());
        assert_eq!(run.orchestration_backend, cloud);

        run.set_status(TeamRunStatus::Running);
        let sidecar = OrchestrationBackendRef::LocalSidecar {
            protocol_version: crate::orchestration::SupportedProtocolVersion::current(),
            driver_version: crate::orchestration::DriverVersion::new("driver.2").unwrap(),
        };
        assert!(run.set_orchestration_backend(sidecar).is_err());
        assert_eq!(run.orchestration_backend, cloud);
    }

    #[test]
    fn restart_recovers_a_stranded_in_flight_command_without_a_false_running_status() {
        // T4's own reducer never leaves a command in flight (D10) — this run
        // simulates state a future async executor left behind, so the
        // recovery path is reachable and pinned rather than met as a
        // surprise later.
        let mut run = run_with(TeamPhase::SubTasks, Vec::new());
        run.driver_progress.in_flight_command_id =
            Some(crate::orchestration::CommandId::new("cmd-9").unwrap());
        run.driver_progress.last_command_seq = 3;
        run.driver_progress.state_revision = 3;

        assert!(run.reconcile_after_restore());

        assert_ne!(
            run.status,
            TeamRunStatus::Running,
            "a restart must never leave a run looking Running with no driver"
        );
        assert_eq!(run.status, TeamRunStatus::Interrupted);
        assert!(run.driver_progress.in_flight_command_id.is_none());

        let records: Vec<_> = run.command_journal.iter().collect();
        assert_eq!(records.len(), 1);
        let record = records[0];
        assert_eq!(record.command_id.as_str(), "cmd-9");
        assert_eq!(record.kind, TeamCommandKind::Unknown);
        assert_eq!(record.outcome, TeamCommandOutcome::Interrupted);
        // `None`, not a sentinel: the original envelope's digest was never
        // recorded, so this matches ANY fingerprint a genuine redelivery of
        // "cmd-9" computes — the reducer replays this `Interrupted` receipt
        // instead of misreading the redelivery as a content mismatch.
        assert_eq!(record.fingerprint, None);
    }

    #[test]
    fn restart_with_no_in_flight_command_journals_nothing() {
        let mut run = run_with(TeamPhase::SubTasks, Vec::new());
        assert!(run.driver_progress.in_flight_command_id.is_none());

        run.reconcile_after_restore();

        assert!(run.command_journal.is_empty());
    }

    #[test]
    fn future_backend_records_become_non_executing_without_losing_the_run() {
        let mut run: TeamRun = serde_json::from_str(
            r#"{
                "id":"r",
                "status":"paused",
                "in_flight_thread":"thread-sensitive",
                "orchestration_backend":{"kind":"quantum_cloud","future_field":"ignored"}
            }"#,
        )
        .expect("unknown backend kind must not fail the whole run");
        assert_eq!(
            run.orchestration_backend.original_unknown_kind(),
            Some("quantum_cloud")
        );
        run.error = Some("older unrelated failure".to_string());
        assert!(run.reconcile_after_restore());
        assert_eq!(run.status, TeamRunStatus::Paused);
        let error = run.error.as_deref().unwrap_or_default();
        assert!(
            error.contains("older unrelated failure"),
            "the original restore error must survive: {:?}",
            run.error
        );
        assert!(
            error.contains("does not understand"),
            "the backend-pin reason must be appended: {:?}",
            run.error
        );
        assert_eq!(run.in_flight_thread.as_deref(), Some("thread-sensitive"));
        assert!(run.status.is_resumable());
        assert!(!run.is_executable_by_current_build());
        assert!(!run.is_live_in_current_build());
    }

    #[test]
    fn future_backend_pause_pending_records_settle_to_recoverable_pause() {
        let mut run: TeamRun = serde_json::from_str(
            r#"{
                "id":"r",
                "status":"pause_pending",
                "pause_requested":true,
                "stopping":true,
                "in_flight_thread":"thread-sensitive",
                "error":"stop was already draining",
                "orchestration_backend":{"kind":"quantum_cloud"}
            }"#,
        )
        .expect("unknown backend kind must not fail the whole run");

        assert!(run.reconcile_after_restore());
        assert_eq!(run.status, TeamRunStatus::Paused);
        assert!(run.status.is_resumable());
        assert!(!run.is_live_in_current_build());
        assert!(!run.pause_requested);
        assert!(!run.stopping);
        assert!(run.in_flight_thread.is_none());
        assert_eq!(
            run.pause_reason.as_deref(),
            Some("the relay restarted while the team was pausing")
        );
        assert_eq!(run.pause_kind, Some(TeamPauseKind::Boundary));
        let error = run.error.as_deref().unwrap_or_default();
        assert!(
            error.contains("stop was already draining"),
            "the prior stop/error reason must survive: {:?}",
            run.error
        );
        assert!(
            error.contains("does not understand"),
            "the backend-pin reason must be appended: {:?}",
            run.error
        );
    }

    #[test]
    fn future_backend_awaiting_user_records_roll_back_and_settle_to_pause() {
        let mut run: TeamRun = serde_json::from_str(
            r#"{
                "id":"r",
                "status":"awaiting_user",
                "phase":"sub_tasks",
                "error":"question was pending",
                "awaiting":{
                    "thread_id":"dev-1",
                    "request_id":"ask-1",
                    "role":"dev",
                    "asked_at":1
                },
                "sub_tasks":[{
                    "id":"s1",
                    "title":"one",
                    "status":"implementing",
                    "rounds_used":1
                }],
                "orchestration_backend":{"kind":"quantum_cloud"}
            }"#,
        )
        .expect("unknown backend kind must not fail the whole run");

        assert!(run.reconcile_after_restore());
        assert_eq!(run.status, TeamRunStatus::Paused);
        assert!(run.status.is_resumable());
        assert!(!run.is_live_in_current_build());
        assert!(run.awaiting.is_none());
        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Pending);
        assert_eq!(run.sub_tasks[0].rounds_used, 1);
        assert_eq!(
            run.pause_reason.as_deref(),
            Some(
                "the relay restarted while the team was waiting on your answer; that step will be re-run"
            )
        );
        assert_eq!(run.pause_kind, Some(TeamPauseKind::Boundary));
        let error = run.error.as_deref().unwrap_or_default();
        assert!(
            error.contains("question was pending"),
            "the prior awaiting-user reason must survive: {:?}",
            run.error
        );
        assert!(
            error.contains("does not understand"),
            "the backend-pin reason must be appended: {:?}",
            run.error
        );
    }

    #[test]
    fn non_paused_future_backend_records_restore_terminal_but_keep_backend_reason() {
        for status in ["queued", "running", "blocked", "resolving"] {
            let mut run: TeamRun = serde_json::from_str(&format!(
                r#"{{
                    "id":"r",
                    "status":"{status}",
                    "orchestration_backend":{{"kind":"quantum_cloud"}}
                }}"#,
            ))
            .expect("unknown backend kind must not fail the whole run");
            run.error = Some("older unrelated failure".to_string());

            assert!(run.reconcile_after_restore());
            assert_eq!(run.status, TeamRunStatus::Failed, "{status}");
            let error = run.error.as_deref().unwrap_or_default();
            assert!(
                error.contains("older unrelated failure"),
                "the original restore error must survive for {status}: {:?}",
                run.error
            );
            assert!(
                error.contains("does not understand"),
                "the backend-pin reason must be appended for {status}: {:?}",
                run.error
            );
            assert!(!run.status.is_resumable(), "{status}");
        }
    }

    #[test]
    fn a_run_missing_its_status_decodes_to_failed() {
        let decoded: TeamRun = serde_json::from_str("{\"id\":\"r\"}").expect("decode");
        assert_eq!(decoded.status, TeamRunStatus::Failed);
        assert!(decoded.status.is_terminal());
    }

    #[test]
    fn paused_is_non_terminal_and_exempt_from_interrupt() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.status = TeamRunStatus::Paused;
        assert!(!run.status.is_terminal(), "paused must stay non-terminal");
        assert!(run.status.is_resumable());

        assert!(
            !run.mark_interrupted_if_stranded(),
            "a deliberate pause has no driver ON PURPOSE and must not be reconciled"
        );
        assert_eq!(run.status, TeamRunStatus::Paused);
    }

    #[test]
    fn a_stranded_running_run_is_reconciled_to_interrupted() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        assert!(run.mark_interrupted_if_stranded());
        assert_eq!(run.status, TeamRunStatus::Interrupted);
        assert!(run.error.is_some(), "the reason must be recorded");

        // Idempotent: a second reconciliation is a no-op.
        assert!(!run.mark_interrupted_if_stranded());
    }

    #[test]
    fn terminal_and_blocked_states_are_sticky() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.set_status(TeamRunStatus::Cancelled);
        run.set_status(TeamRunStatus::Running);
        assert_eq!(
            run.status,
            TeamRunStatus::Cancelled,
            "a cancel that won the race must not be clobbered"
        );

        let mut blocked = run_with(TeamPhase::SubTasks, vec![]);
        blocked.block("drain unconfirmed");
        blocked.set_status(TeamRunStatus::Running);
        assert_eq!(blocked.status, TeamRunStatus::Blocked);
        assert!(
            !blocked.status.is_terminal(),
            "blocked still owns its locks"
        );
    }

    #[test]
    fn force_mark_status_can_relabel_a_terminal_run() {
        let mut run = run_with(TeamPhase::Finished, vec![]);
        run.status = TeamRunStatus::Escalated;
        run.error = Some("ran out of rounds".into());

        assert!(run.force_mark_status(TeamRunStatus::Cancelled));
        assert_eq!(run.status, TeamRunStatus::Cancelled);

        assert!(run.force_mark_status(TeamRunStatus::Done));
        assert_eq!(run.status, TeamRunStatus::Done);
        assert!(run.error.is_none(), "done clears the error");
    }

    #[test]
    fn pausing_is_a_request_then_a_boundary_settlement() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.request_pause("device-9");
        assert_eq!(
            run.status,
            TeamRunStatus::PausePending,
            "requesting a pause must not claim the run is already paused"
        );
        assert!(run.pause_requested);

        assert!(run.settle_paused("boundary reached", TeamPauseKind::Boundary));
        assert_eq!(run.status, TeamRunStatus::Paused);
        assert!(!run.pause_requested, "the request is consumed by settling");
        assert_eq!(run.pause_reason.as_deref(), Some("boundary reached"));
        assert_eq!(run.pause_kind, Some(TeamPauseKind::Boundary));
    }

    #[test]
    fn the_team_lead_succession_chain_is_capped() {
        // A task no lead can hold must fail loudly rather than replace its lead
        // forever, each successor dying the same way. The cap lives here rather
        // than in the driver because the driver's own retry budget hides it: one
        // action can only ever trigger one re-seed, so nothing upstream would
        // reach eight generations on its own.
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        for generation in 1..MAX_TL_GENERATIONS {
            run.tl_thread_id = format!("tl-{generation}");
            run.tl_turns_this_generation = 12;
            assert!(
                run.retire_tl("out of room"),
                "generation {generation} should still be replaceable"
            );
            assert!(run.tl_thread_id.is_empty(), "the seat is vacated");
            assert_eq!(
                run.tl_turns_this_generation, 0,
                "the successor starts on a fresh budget"
            );
        }

        run.tl_thread_id = "tl-last".to_string();
        assert_eq!(run.tl_generation_count(), MAX_TL_GENERATIONS);
        assert!(
            !run.retire_tl("out of room"),
            "the chain must not grow past its cap"
        );
        assert_eq!(
            run.tl_thread_id, "tl-last",
            "a refused retirement leaves the current lead in place"
        );
        assert_eq!(run.tl_succession.len(), MAX_TL_GENERATIONS - 1);
    }

    #[test]
    fn a_reseed_request_keeps_the_reason_that_diagnosed_it() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.tl_thread_id = "tl-1".to_string();
        run.request_tl_reseed("the session did not survive the restart");
        run.request_tl_reseed("out of room");
        assert_eq!(
            run.tl_reseed_reason.as_deref(),
            Some("the session did not survive the restart"),
            "the FIRST diagnosis is the one that knew what was wrong"
        );

        assert!(run.retire_tl("out of room"));
        assert!(
            run.tl_reseed_reason.is_none(),
            "acting on the request consumes it, or the next loop re-seeds forever"
        );
    }

    #[test]
    fn a_draining_stop_outranks_the_failure_it_caused_but_a_pause_does_not() {
        // Two situations that look identical on the record and are not.
        //
        // A STOP kills the turn the driver is waiting on, so the driver sees it
        // end with no reply and calls `fail`. Between the request and the
        // settlement the run is `PausePending` — neither terminal nor
        // settled-without-driver — so without this the driver wins and the user
        // gets `failed` for pressing Cancel.
        let mut stopping = run_with(TeamPhase::SubTasks, vec![]);
        stopping.request_stop("device-1");
        assert_eq!(stopping.status, TeamRunStatus::PausePending);
        assert!(stopping.stopping);

        stopping.fail("the team lead replied with nothing");
        assert_eq!(
            stopping.status,
            TeamRunStatus::PausePending,
            "a stop that is draining outranks the failure it caused"
        );
        assert_eq!(
            stopping.error.as_deref(),
            Some("the team lead replied with nothing"),
            "the reason is still recorded — it is just not the run's verdict"
        );
        assert!(stopping.settle_paused("stopped by the user", TeamPauseKind::User));
        assert_eq!(stopping.status, TeamRunStatus::Paused);
        assert!(!stopping.stopping, "settling ends the drain");
        assert_eq!(stopping.pause_kind, Some(TeamPauseKind::User));

        // A graceful PAUSE stops nothing, so a turn that fails during one failed
        // on its own. Suppressing it here would strand the run in `PausePending`
        // with no driver left to settle it: it blocks every future task, and
        // Resume refuses it for not being `Paused`.
        let mut pausing = run_with(TeamPhase::SubTasks, vec![]);
        pausing.request_pause("device-1");
        assert!(!pausing.stopping, "a pause is not a drain");
        pausing.fail("the provider errored");
        assert_eq!(
            pausing.status,
            TeamRunStatus::Failed,
            "a failure during a graceful pause is the run's own"
        );

        // And a cancel still lands as itself either way.
        let mut cancelling = run_with(TeamPhase::SubTasks, vec![]);
        cancelling.request_stop("device-1");
        cancelling.fail("the team lead replied with nothing");
        assert!(cancelling.cancel("the task was cancelled by the user"));
        assert_eq!(cancelling.status, TeamRunStatus::Cancelled);
        assert!(!cancelling.stopping);
    }

    #[test]
    fn a_run_the_user_settled_is_off_limits_to_its_driver() {
        // A force stop settles the run while the driver is still inside a turn.
        // That driver then watches its own turn end with no reply and tries to
        // record a failure — so every state a user settles has to be unwritable
        // by a driver, or a successful stop lands as Failed.
        for settled in [
            TeamRunStatus::Paused,
            TeamRunStatus::Blocked,
            TeamRunStatus::Resolving,
        ] {
            let mut run = run_with(TeamPhase::SubTasks, vec![]);
            run.status = settled;

            run.set_status(TeamRunStatus::Running);
            assert_eq!(run.status, settled, "a driver must not restart {settled:?}");
            run.fail("the team lead replied with nothing");
            assert_eq!(
                run.status, settled,
                "a driver must not fail a run it no longer drives"
            );
            assert!(
                run.error.is_none(),
                "and must not leave its own reason behind either"
            );

            // The user, however, can always end it.
            assert!(run.cancel("stopped by the user"));
            assert_eq!(run.status, TeamRunStatus::Cancelled);
        }
    }

    #[test]
    fn every_settled_stop_clears_the_in_flight_marker() {
        // `in_flight_thread` names a turn that may be running with no runtime to
        // observe it, and cleanup reads that as UNKNOWN rather than idle. Leaving
        // a stale one behind therefore blocks a run that is genuinely quiescent —
        // and every settlement below has just PROVEN quiescence.
        let mut paused = run_with(TeamPhase::SubTasks, vec![]);
        paused.in_flight_thread = Some("thread-1".to_string());
        assert!(paused.settle_paused("boundary", TeamPauseKind::Boundary));
        assert!(paused.in_flight_thread.is_none());

        let mut cancelled = run_with(TeamPhase::SubTasks, vec![]);
        cancelled.in_flight_thread = Some("thread-1".to_string());
        assert!(cancelled.cancel("stopped by the user"));
        assert!(cancelled.in_flight_thread.is_none());

        let mut recovered = run_with(TeamPhase::SubTasks, vec![]);
        recovered.in_flight_thread = Some("thread-1".to_string());
        recovered.block("a drain that did not confirm");
        assert!(recovered.begin_resolving_blocked());
        assert!(recovered.resolve_as_paused("recovered", TeamPauseKind::User));
        assert!(recovered.in_flight_thread.is_none());
    }

    #[test]
    fn a_blocked_run_recovers_into_a_resumable_pause_and_only_once() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.sub_tasks = vec![sub_task(SubTaskStatus::Done, true)];
        run.block("a drain that did not confirm");

        assert!(run.begin_resolving_blocked());
        assert_eq!(run.status, TeamRunStatus::Resolving);
        assert!(
            !run.begin_resolving_blocked(),
            "a second recovery must not drain the same threads again"
        );

        assert!(run.resolve_as_paused(
            "recovered by stopping every owned turn",
            TeamPauseKind::User
        ));
        assert_eq!(
            run.status,
            TeamRunStatus::Paused,
            "a drained run keeps its work; it does not get thrown away"
        );
        assert!(run.status.is_resumable());
        assert_eq!(
            run.sub_tasks[0].status,
            SubTaskStatus::Done,
            "finished sub-tasks survive the recovery"
        );
        assert!(
            !run.resolve_as_paused("again", TeamPauseKind::User),
            "only a Resolving run can be resolved"
        );
    }

    #[test]
    fn an_interrupted_recovery_falls_back_to_blocked_not_to_limbo() {
        // `Resolving` is non-terminal and has no driver, so a recovery that dies
        // mid-drain would strand the run somewhere nothing ever moves it from.
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.block("a drain that did not confirm");
        assert!(run.begin_resolving_blocked());

        assert!(run.restore_resolving_as_blocked("the recovery was interrupted"));
        assert_eq!(run.status, TeamRunStatus::Blocked);
        assert!(!run.status.is_terminal(), "it still owns its threads");
        assert!(
            !run.restore_resolving_as_blocked("again"),
            "a run that is not resolving has nothing to restore"
        );
    }

    #[test]
    fn settling_a_pause_cannot_resurrect_a_terminal_run() {
        let mut run = run_with(TeamPhase::SubTasks, vec![]);
        run.request_pause("device-9");
        run.set_status(TeamRunStatus::Cancelled);
        assert!(!run.settle_paused("too late", TeamPauseKind::Boundary));
        assert_eq!(run.status, TeamRunStatus::Cancelled);
    }

    #[test]
    fn the_current_sub_task_is_derived_not_stored() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![
                sub_task(SubTaskStatus::Done, true),
                sub_task(SubTaskStatus::Pending, false),
            ],
        );
        assert_eq!(run.current_sub_task(), Some(1));

        run.sub_tasks[1].status = SubTaskStatus::Done;
        run.sub_tasks[1].digested = true;
        assert_eq!(run.current_sub_task(), None, "everything settled");
    }

    #[test]
    fn unknown_phase_and_subtask_status_decode_leniently() {
        // `TeamRunStatus` was never the only enum in this record. A strict derive
        // on either of these has exactly the same blast radius: the whole
        // `PersistedRelayState` decode fails and startup discards the state file.
        let phase: TeamPhase =
            serde_json::from_str("\"a_phase_from_a_future_build\"").expect("must not error");
        assert_eq!(
            phase,
            TeamPhase::Finished,
            "an uninterpretable phase decodes to the one that ends the run, so a \
             future build's phase can never be guessed at"
        );

        let status: SubTaskStatus =
            serde_json::from_str("\"a_status_from_a_future_build\"").expect("must not error");
        assert_eq!(status, SubTaskStatus::Failed);
        assert!(status.is_terminal(), "so it is never silently re-run");

        // A whole run carrying both still decodes.
        let raw = "{\"id\":\"r\",\"phase\":\"warp_drive\",\
\"sub_tasks\":[{\"id\":\"s\",\"status\":\"quantum\"}]}";
        let run: TeamRun = serde_json::from_str(raw).expect("must not error");
        assert_eq!(run.phase, TeamPhase::Finished);
        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Failed);
    }

    #[test]
    fn known_phases_and_subtask_statuses_round_trip() {
        for phase in [
            TeamPhase::Intake,
            TeamPhase::Design,
            TeamPhase::DesignReview,
            TeamPhase::Planning,
            TeamPhase::SubTasks,
            TeamPhase::MrGate,
            TeamPhase::Wrapping,
            TeamPhase::Finished,
        ] {
            let encoded = serde_json::to_string(&phase).expect("serialize");
            assert_eq!(encoded, format!("\"{}\"", phase.as_str()));
            let decoded: TeamPhase = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, phase);
        }
        for status in [
            SubTaskStatus::Pending,
            SubTaskStatus::Implementing,
            SubTaskStatus::Done,
            SubTaskStatus::Escalated,
            SubTaskStatus::Failed,
            SubTaskStatus::Skipped,
            SubTaskStatus::Superseded,
        ] {
            let encoded = serde_json::to_string(&status).expect("serialize");
            assert_eq!(encoded, format!("\"{}\"", status.as_str()));
            let decoded: SubTaskStatus = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, status);
        }
        // A sub-task with no recorded status has simply not started.
        let task: SubTask = serde_json::from_str("{\"id\":\"s\"}").expect("decode");
        assert_eq!(task.status, SubTaskStatus::Pending);
    }

    #[test]
    fn run_level_threads_are_owned_and_drainable() {
        // The design reviewer, the MR reviewers and the MR-revision dev belong to
        // no sub-task. Before this they had nowhere to live, so a cancel during
        // the MR gate would leave an orphaned turn — and the MR-revision dev keeps
        // WRITING the worktree after the run's locks are released.
        let mut run = run_with(TeamPhase::MrGate, vec![]);
        run.tl_thread_id = "tl-1".to_string();
        run.record_run_thread("design-reviewer-1");
        run.record_run_thread("mr-reviewer-1");
        run.record_run_thread("mr-dev-1");
        run.record_run_thread("mr-reviewer-1");

        let owned = run.owned_thread_ids();
        for expected in ["tl-1", "design-reviewer-1", "mr-reviewer-1", "mr-dev-1"] {
            assert!(
                owned.contains(&expected.to_string()),
                "missing {expected} in {owned:?}"
            );
        }
        assert_eq!(
            owned.len(),
            4,
            "recording twice must not duplicate: {owned:?}"
        );
    }

    #[test]
    fn a_run_with_an_unresumable_tl_settles_terminal_but_keeps_its_worktree() {
        let mut run = run_with(TeamPhase::Intake, vec![]);
        run.status = TeamRunStatus::Paused;
        run.tl_thread_id = "claude-pending-3".to_string();
        run.branch = "task/x".to_string();
        run.cwd = "/repo/.sealwire/worktrees/x".to_string();

        run.detach_unresumable_tl();

        assert_eq!(
            run.status,
            TeamRunStatus::Interrupted,
            "a run naming a thread that cannot come back must not offer Resume"
        );
        assert!(run.tl_thread_id.is_empty());
        assert!(run.error.is_some());
        assert_eq!(
            run.cwd, "/repo/.sealwire/worktrees/x",
            "the worktree is still on disk, so the record of it must survive"
        );
        assert_eq!(run.branch, "task/x");
    }

    #[test]
    fn minted_sub_task_ids_never_repeat_or_go_backwards() {
        // The bug being removed: positional ids meant `st-1` before a replan and
        // `st-1` after it named two different pieces of work. A mint that can
        // collide inside one planning burst would leave exactly that.
        use std::collections::HashSet;

        let ids: Vec<String> = (0..4000).map(|_| mint_sub_task_id()).collect();
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "every minted id must be distinct");

        let mut previous = 0u64;
        for id in &ids {
            let counter = id
                .strip_prefix("st-")
                .unwrap_or_else(|| panic!("id must be `st-<hex>`, got {id}"));
            let value = u64::from_str_radix(counter, 16)
                .unwrap_or_else(|_| panic!("id must carry a hex number, got {id}"));
            assert!(
                value > previous,
                "the sequence must strictly increase: {value} came after {previous}"
            );
            previous = value;
        }
    }

    #[test]
    fn a_frozen_clock_still_mints_distinct_rising_numbers() {
        // The atomic is the whole mechanism, and a real clock hides whether it is
        // there — reads usually tick on their own. Freeze the timestamp so only
        // the bump can make these differ.
        use std::collections::HashSet;

        let last = AtomicU64::new(0);
        let frozen = 1_700_000_000_000_000_000_u64;
        let numbers: Vec<u64> = (0..1000).map(|_| mint_number(&last, frozen)).collect();

        let unique: HashSet<&u64> = numbers.iter().collect();
        assert_eq!(unique.len(), numbers.len(), "same nanosecond, same id");
        assert!(
            numbers.windows(2).all(|pair| pair[1] > pair[0]),
            "the sequence must rise even while the clock stands still"
        );
        assert_eq!(numbers[0], frozen, "the first mint is the clock reading");
    }

    #[test]
    fn owned_threads_span_the_tl_and_every_sub_task() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![sub_task(SubTaskStatus::Pending, false)],
        );
        run.tl_thread_id = "tl-1".to_string();
        run.sub_tasks[0].owned_thread_ids = vec!["dev-1".to_string(), "rev-1".to_string()];

        let owned = run.owned_thread_ids();
        assert!(owned.contains(&"tl-1".to_string()));
        assert!(owned.contains(&"dev-1".to_string()));
        assert!(owned.contains(&"rev-1".to_string()));
        assert_eq!(owned.len(), 3, "no duplicates: {owned:?}");
    }

    #[test]
    fn provider_for_owned_thread_only_returns_confident_role_mappings() {
        let mut run = run_with(
            TeamPhase::Finished,
            vec![sub_task(SubTaskStatus::Done, true)],
        );
        run.tl_thread_id = "tl-1".to_string();
        run.tl_provider = "codex".to_string();
        run.dev_provider = "claude_code".to_string();
        run.reviewer_provider = "codex".to_string();
        run.mr_dev_thread_id = Some("mr-dev".to_string());
        run.run_owned_thread_ids = vec![
            "design-rev".to_string(),
            "tagged-tl".to_string(),
            "tagged-dev".to_string(),
        ];
        run.run_owned_thread_roles
            .insert("tagged-tl".to_string(), "tl".to_string());
        run.run_owned_thread_roles
            .insert("tagged-dev".to_string(), "dev".to_string());
        run.sub_tasks[0].dev_thread_id = Some("dev-slot".to_string());
        run.sub_tasks[0].reviewer_thread_id = Some("rev-slot".to_string());
        run.sub_tasks[0].owned_thread_ids = vec![
            "dev-slot".to_string(),
            "rev-slot".to_string(),
            "old-mixed".to_string(),
        ];

        assert_eq!(run.provider_for_owned_thread("tl-1"), Some("codex"));
        assert_eq!(run.provider_for_owned_thread("mr-dev"), Some("claude_code"));
        assert_eq!(run.provider_for_owned_thread("tagged-tl"), Some("codex"));
        assert_eq!(
            run.provider_for_owned_thread("tagged-dev"),
            Some("claude_code")
        );
        assert_eq!(
            run.provider_for_owned_thread("dev-slot"),
            Some("claude_code")
        );
        assert_eq!(run.provider_for_owned_thread("rev-slot"), Some("codex"));
        assert_eq!(
            run.provider_for_owned_thread("design-rev"),
            None,
            "untagged run-owned seats must not guess reviewer"
        );
        assert_eq!(
            run.provider_for_owned_thread("old-mixed"),
            None,
            "historical owned_thread_ids without a dedicated slot must not guess"
        );

        run.record_owned_thread_provider("old-mixed", "cursor");
        assert_eq!(
            run.provider_for_owned_thread("old-mixed"),
            Some("cursor"),
            "the provider captured at seat creation beats role-level inference"
        );
        assert!(run.rekey_thread("old-mixed", "real-mixed"));
        assert_eq!(
            run.provider_for_owned_thread("real-mixed"),
            Some("cursor"),
            "pending-session promotion must carry provider ownership"
        );
        run.release_owned_thread("real-mixed");
        assert!(!run.owned_thread_providers.contains_key("real-mixed"));
    }

    fn spent_sub_task(id: &str, status: SubTaskStatus) -> SubTask {
        SubTask {
            id: id.to_string(),
            rounds_used: 3,
            ..sub_task(status, true)
        }
    }

    #[test]
    fn a_filtered_revive_takes_the_named_sub_task_and_nothing_else() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![
                spent_sub_task("st-1", SubTaskStatus::Done),
                spent_sub_task("st-2", SubTaskStatus::Escalated),
            ],
        );

        assert!(run.revive_sub_tasks(Some(&["st-1".to_string()])));

        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Pending);
        assert_eq!(run.sub_tasks[0].rounds_used, 0, "a fresh review budget");
        assert!(!run.sub_tasks[0].digested, "its outcome is owed again");
        assert_eq!(
            run.sub_tasks[1].status,
            SubTaskStatus::Escalated,
            "an unnamed sub-task stays settled even when it is escalated"
        );
        assert_eq!(run.sub_tasks[1].rounds_used, 3);
        assert!(run.sub_tasks[1].digested);
    }

    /// A rerun is the user rejecting the attempt, and that attempt is what the
    /// session holds. Handing the same session back gives the retry the reasoning
    /// it is meant to escape — and until sessions could be shared, the driver's
    /// `rounds_used == 0` test happened to be what started a fresh one.
    #[test]
    fn a_revived_sub_task_does_not_inherit_the_session_that_failed_it() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![spent_sub_task("st-1", SubTaskStatus::Escalated)],
        );
        run.sub_tasks[0].dev_thread_id = Some("dev-1".to_string());
        run.sub_tasks[0].owned_thread_ids = vec!["dev-1".to_string()];

        assert!(run.revive_sub_tasks(Some(&["st-1".to_string()])));

        assert_eq!(
            run.sub_tasks[0].dev_thread_id, None,
            "the retry must start its own session"
        );
        assert_eq!(
            run.sub_tasks[0].reruns, 1,
            "and say so, so a shared session is not handed to it by the group"
        );
        assert_eq!(
            run.sub_tasks[0].owned_thread_ids,
            vec!["dev-1".to_string()],
            "the old thread still has to be drained, so it stays owned"
        );
    }

    /// The reviewer gate refuses to start a reviewer turn while this is zero —
    /// there is nothing to review until a dev turn lands. A rerun starts over on
    /// an unchanged branch, so inheriting the last attempt's review target opens
    /// that gate before the rerun's dev has done anything.
    #[test]
    fn a_revived_sub_task_has_fresh_candidate_gate_state() {
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![
                spent_sub_task("st-1", SubTaskStatus::Escalated),
                spent_sub_task("st-2", SubTaskStatus::Escalated),
            ],
        );
        run.sub_tasks[0].dev_turns_landed = 2;
        run.sub_tasks[0].round_base_sha = "base-1".to_string();
        run.sub_tasks[0].candidate_sha = "candidate-1".to_string();
        run.sub_tasks[0].verdict_candidate_sha = "candidate-1".to_string();
        run.sub_tasks[0].stale_review_retries = 1;
        run.sub_tasks[1].dev_turns_landed = 1;
        run.sub_tasks[1].round_base_sha = "base-2".to_string();
        run.sub_tasks[1].candidate_sha = "candidate-2".to_string();
        run.mr_round_base_sha = "mr-base".to_string();
        run.mr_candidate_sha = "mr-candidate".to_string();
        run.mr_verdict_candidate_sha = "mr-candidate".to_string();
        run.mr_stale_review_retries = 2;

        assert!(run.revive_sub_tasks(Some(&["st-1".to_string()])));

        assert_eq!(
            run.sub_tasks[0].dev_turns_landed, 0,
            "the rerun's reviewer must wait on the rerun's own dev turn"
        );
        assert_eq!(run.sub_tasks[0].round_base_sha, "");
        assert_eq!(run.sub_tasks[0].candidate_sha, "");
        assert_eq!(run.sub_tasks[0].verdict_candidate_sha, "");
        assert_eq!(run.sub_tasks[0].stale_review_retries, 0);
        assert_eq!(
            run.sub_tasks[1].dev_turns_landed, 1,
            "a sub-task this revive did not take keeps its landed count"
        );
        assert_eq!(run.sub_tasks[1].round_base_sha, "base-2");
        assert_eq!(run.sub_tasks[1].candidate_sha, "candidate-2");
        assert_eq!(run.mr_round_base_sha, "");
        assert_eq!(run.mr_candidate_sha, "");
        assert_eq!(run.mr_verdict_candidate_sha, "");
        assert_eq!(
            run.mr_stale_review_retries, 0,
            "a reopened run must not inherit the previous MR stale budget"
        );
    }

    fn planned_sub_task(id: &str) -> SubTask {
        SubTask {
            id: id.to_string(),
            ..sub_task(SubTaskStatus::Pending, false)
        }
    }

    #[test]
    fn a_replan_retires_what_it_replaces_instead_of_dropping_it() {
        // A replan is authored from `Planning`, before any of it has been worked,
        // so everything it replaces is still pending.
        let mut run = run_with(
            TeamPhase::Planning,
            vec![planned_sub_task("st-1"), planned_sub_task("st-2")],
        );

        run.replan_sub_tasks(vec![planned_sub_task("st-3")]);

        let ids: Vec<&str> = run.sub_tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            ["st-1", "st-2", "st-3"],
            "an id from before the replan must still name its record"
        );
        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Superseded);
        assert_eq!(run.sub_tasks[1].status, SubTaskStatus::Superseded);
        assert_eq!(
            run.current_sub_task(),
            Some(2),
            "a retired one must not be picked up again"
        );
    }

    /// A reopened run replans with the last cycle's work still in the list, so
    /// "everything a replan replaces is still pending" holds only on the first
    /// plan. Overwriting a finished outcome loses the record the retained entry
    /// exists to keep — and `finalize` reads those statuses, so a run that has
    /// been reopened once could never reach `Done` again.
    #[test]
    fn a_replan_leaves_what_already_finished_alone() {
        let mut run = run_with(TeamPhase::Planning, vec![planned_sub_task("st-1")]);
        run.sub_tasks[0].status = SubTaskStatus::Done;
        run.sub_tasks[0].digested = true;

        run.replan_sub_tasks(vec![planned_sub_task("st-2")]);

        assert_eq!(
            run.sub_tasks[0].status,
            SubTaskStatus::Done,
            "a sub-task that finished was not superseded by the next plan"
        );
    }

    #[test]
    fn a_replanned_id_landing_on_a_retained_one_is_minted_again() {
        // A restart resets the mint, so the plan after it can carry an id an
        // earlier plan already handed out. Two records answering to one id makes
        // a rerun reach only the first, which is the record nobody asked for.
        let mut run = run_with(TeamPhase::Planning, vec![planned_sub_task("st-1")]);

        run.replan_sub_tasks(vec![planned_sub_task("st-1")]);

        assert_eq!(run.sub_tasks.len(), 2, "neither record may be dropped");
        assert_eq!(
            run.sub_tasks[0].id, "st-1",
            "the retired one keeps the id the user is holding"
        );
        assert_ne!(
            run.sub_tasks[1].id, "st-1",
            "the newcomer must not answer to it as well"
        );
        assert!(
            run.sub_tasks[1].id.starts_with("st-"),
            "the replacement is a real minted id, got {}",
            run.sub_tasks[1].id
        );
        assert_eq!(
            run.current_sub_task(),
            Some(1),
            "and the new plan is what the team goes on to work"
        );
    }

    #[test]
    fn a_named_sub_task_in_flight_is_left_alone() {
        // Resetting a turn that is still running would throw away work nobody
        // asked to discard, so the guard lives here rather than in the caller.
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![spent_sub_task("st-1", SubTaskStatus::Implementing)],
        );

        assert!(!run.revive_sub_tasks(Some(&["st-1".to_string()])));

        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Implementing);
        assert_eq!(run.sub_tasks[0].rounds_used, 3);
        assert!(run.sub_tasks[0].digested);
    }

    #[test]
    fn a_filtered_revive_reopens_the_run_the_same_way_the_unfiltered_one_does() {
        let mut run = run_with(
            TeamPhase::MrGate,
            vec![
                spent_sub_task("st-1", SubTaskStatus::Done),
                spent_sub_task("st-2", SubTaskStatus::Done),
            ],
        );
        run.unresolved = vec!["the retry path is untested".to_string()];
        run.mr_rounds_used = 2;
        run.design_review_rounds = 1;
        run.mr_verdict = Some(WorkflowVerdict::needs_changes(vec!["fix it".to_string()]));

        assert!(run.revive_sub_tasks(Some(&["st-2".to_string()])));

        assert!(run.unresolved.is_empty(), "`finalize` refuses leftovers");
        assert_eq!(run.mr_rounds_used, 0);
        assert_eq!(run.design_review_rounds, 0);
        assert_eq!(run.mr_verdict, None);
        assert_eq!(
            run.phase,
            TeamPhase::SubTasks,
            "the gate never looks at sub-tasks"
        );
        assert_eq!(
            run.current_sub_task(),
            Some(1),
            "the revived sub-task is the one the run picks up"
        );
    }

    #[test]
    fn the_unfiltered_revive_still_takes_every_escalated_sub_task() {
        let mut run = run_with(
            TeamPhase::Wrapping,
            vec![
                spent_sub_task("st-1", SubTaskStatus::Done),
                spent_sub_task("st-2", SubTaskStatus::Escalated),
                spent_sub_task("st-3", SubTaskStatus::Escalated),
            ],
        );
        run.unresolved = vec!["a finding".to_string()];
        run.mr_rounds_used = 2;

        assert!(run.revive_escalated_sub_tasks());

        assert_eq!(
            run.sub_tasks[0].status,
            SubTaskStatus::Done,
            "not escalated"
        );
        for index in [1, 2] {
            assert_eq!(run.sub_tasks[index].status, SubTaskStatus::Pending);
            assert_eq!(run.sub_tasks[index].rounds_used, 0);
            assert!(!run.sub_tasks[index].digested);
        }
        assert!(run.unresolved.is_empty());
        assert_eq!(run.mr_rounds_used, 0);
        assert_eq!(run.phase, TeamPhase::SubTasks);
    }

    #[test]
    fn an_unfiltered_revive_with_nothing_escalated_changes_nothing() {
        let mut run = run_with(
            TeamPhase::MrGate,
            vec![spent_sub_task("st-1", SubTaskStatus::Done)],
        );
        run.unresolved = vec!["a finding".to_string()];

        assert!(!run.revive_escalated_sub_tasks());

        assert_eq!(run.sub_tasks[0].status, SubTaskStatus::Done);
        assert_eq!(run.unresolved.len(), 1, "no rewind without a revival");
        assert_eq!(run.phase, TeamPhase::MrGate);
    }

    #[test]
    fn a_closing_phase_written_over_a_waiting_sub_task_is_pulled_back() {
        // The driver picks the next phase before its turn and writes it after, so
        // a revival that lands during the turn arrives before a decision that
        // knows nothing about it.
        let mut run = run_with(
            TeamPhase::SubTasks,
            vec![spent_sub_task("st-1", SubTaskStatus::Done)],
        );
        assert!(run.revive_sub_tasks(Some(&["st-1".to_string()])));

        run.phase = TeamPhase::Wrapping;
        run.mr_verdict = Some(WorkflowVerdict::approved());
        run.unresolved = vec!["the retry path is untested".to_string()];

        assert!(run.hold_phase_for_waiting_sub_tasks());

        assert_eq!(run.phase, TeamPhase::SubTasks);
        assert_eq!(run.current_sub_task(), Some(0));
        assert_eq!(
            run.mr_verdict, None,
            "that verdict judged the diff the rerun is about to change"
        );
        assert!(
            run.unresolved.is_empty(),
            "and its findings would keep the run from ever reaching Done: {:?}",
            run.unresolved
        );
    }

    #[test]
    fn a_phase_the_sub_tasks_are_really_done_with_is_left_where_the_driver_put_it() {
        let mut run = run_with(
            TeamPhase::Finished,
            vec![spent_sub_task("st-1", SubTaskStatus::Done)],
        );
        run.mr_verdict = Some(WorkflowVerdict::approved());

        assert!(!run.hold_phase_for_waiting_sub_tasks());

        assert_eq!(run.phase, TeamPhase::Finished);
        assert!(run.mr_verdict.is_some(), "nothing to invalidate");
    }

    #[test]
    fn the_phases_before_the_sub_tasks_are_never_pulled_back() {
        // `Planning` ends by writing the sub-task list, every one of them waiting.
        // Reading that as a rerun would put the run in a phase it has not reached.
        let mut run = run_with(
            TeamPhase::Planning,
            vec![sub_task(SubTaskStatus::Pending, false)],
        );

        assert!(!run.hold_phase_for_waiting_sub_tasks());

        assert_eq!(run.phase, TeamPhase::Planning);
    }
}
