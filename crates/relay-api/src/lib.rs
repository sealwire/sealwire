//! The seam between the public relay and the private crate.
//!
//! # Why this crate exists
//!
//! A private orchestrator (a task list, a task team) needs to drive the relay:
//! start child workflows, resolve providers, take the session slot. The relay in
//! turn needs to ask the orchestrator questions: is this workspace busy, is this
//! thread locked, what should the snapshot say. That is a two-way dependency, and
//! Cargo rejects a package cycle outright — even when the *targets* would be
//! acyclic.
//!
//! So neither side names the other. Both name THIS crate:
//!
//! ```text
//!   relay-api  (public, this crate — traits + shared vocabulary, no logic)
//!      ^   ^
//!      |   +---- sealwire-private (private) ------+
//!      |                                          |
//!      +-------- relay-server (public) <----------+
//! ```
//!
//! `sealwire-private` implements [`Orchestrator`] / [`TeamDriver`] and consumes
//! [`RelayPort`] / [`TeamPort`]. `relay-server` implements the capability traits
//! for its `AppState` and holds only trait objects. The public repo builds and is
//! fully auditable with no engine registered at all — the routes simply report
//! the feature absent.
//!
//! # What belongs here
//!
//! Types and traits ONLY. Anything with behaviour worth hiding belongs in the
//! private crate; anything with behaviour worth auditing belongs in the server.
//! A method added here is a capability permanently exposed to the private side,
//! so keep the surface deliberate and small.

use serde::{Deserialize, Serialize};

pub mod delegation;
pub mod orchestration;
pub mod review;
pub mod team;
pub mod team_command;

pub use review::{
    AnchorStatus, CommentSide, FileReviewTickStatus, FileReviewTickView, LineAnchor,
    RelocateOutcome, ReviewAnchors, ReviewAuthorKind, ReviewComment, ReviewCommentStatus,
    ReviewCommentView, WINDOW_CONTEXT_LINES,
};

use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the epoch, for the records defined here.
pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// A review step's machine-readable result. This is the "structured verdict"
/// shape decided in the design doc; phase 1 derives it from the reviewer's text
/// (reusing the existing `VERDICT:` parsing). How a real provider is made to emit
/// this directly (required tool call vs. parse-last-message) is open for chunk
/// 2/3 — `fake_provider` returns it deterministically for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowVerdict {
    pub approved: bool,
    pub summary: Option<String>,
    pub findings: Vec<String>,
}

impl WorkflowVerdict {
    pub fn approved() -> Self {
        Self {
            approved: true,
            summary: None,
            findings: Vec::new(),
        }
    }

    pub fn needs_changes(findings: Vec<String>) -> Self {
        Self {
            approved: false,
            summary: None,
            findings,
        }
    }
}

/// Committed Git object pair a reviewer must inspect.
///
/// The relay builds this from `base_sha..candidate_sha`; reviewers may inspect
/// the full objects themselves, but prompts should not inline the full raw diff.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitReviewTarget {
    pub cwd: String,
    pub base_sha: String,
    pub candidate_sha: String,
    pub generated_at: u64,
    /// Output of `git diff --name-status --find-renames base candidate --`.
    pub manifest: String,
    /// Output of `git diff --stat --summary --find-renames base candidate --`.
    pub stat: String,
}

/// Lifecycle of a single run — a workflow, or one task's child Code Flow.
///
/// Shared vocabulary: the public workflow runner owns it, and a private
/// orchestrator maps its children's outcomes through it. Terminal states are
/// `Done`, `Escalated`, `Failed`, `Interrupted`, and `Cancelled`.
///
/// `Default` is deliberately a TERMINAL state: a persisted run written by a build
/// that later drops a variant must never decode into something that can strand a
/// workspace lock forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Recorded, orchestrator not yet started.
    Queued,
    /// The serial runner is driving steps.
    Running,
    /// The reviewer approved (or a single-step run finished). TERMINAL.
    Done,
    /// Ran out of `max_rounds` without approval; control returns to the user.
    /// TERMINAL.
    Escalated,
    /// Default only for serde forward-compat: a persisted run missing its status
    /// decodes to a safe TERMINAL state that can never strand a tree lock.
    #[default]
    Failed,
    /// A cleanup/stop path could not confirm that a file-mutating turn actually
    /// stopped. Non-terminal on purpose: the run continues to own its thread and
    /// workspace until restart reconciliation or an explicit recovery action.
    Blocked,
    /// An explicit recovery action is stopping owned turns. Non-terminal so the
    /// run continues to own its thread/workspace and duplicate recovery attempts
    /// cannot drain the same threads.
    Resolving,
    /// The run's orchestrator was lost (relay restart, or mid-session task death)
    /// while still non-terminal. The restore/lifeguard path reconciles to this so
    /// a run is never persisted `Running` with no driver. TERMINAL — the card
    /// offers a one-tap re-run from the last completed step. TREE STATE IS NOT
    /// RESTORED: an interrupted run may leave a dirty tree.
    Interrupted,
    /// The user stopped the run before it finished. TERMINAL.
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Done => "done",
            RunStatus::Escalated => "escalated",
            RunStatus::Failed => "failed",
            RunStatus::Blocked => "blocked",
            RunStatus::Resolving => "resolving",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Done
                | RunStatus::Escalated
                | RunStatus::Failed
                | RunStatus::Interrupted
                | RunStatus::Cancelled
        )
    }
}

/// What a user may do with a thread an orchestrator owns.
///
/// One vocabulary so every lock call site in the relay gets ONE consistent answer
/// rather than each guard inventing its own notion of "is this thread busy".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThreadGate {
    /// No orchestrator owns this thread or its workspace.
    #[default]
    Free,
    /// An orchestrator is driving it; a user turn would interleave with the
    /// driver's own.
    Locked,
    /// The orchestrator owns the thread but is parked, and this particular seat is
    /// where a user redirects the work. Conversable.
    ConversableWhileParked,
}

/// Everything an orchestrator needs to resolve a parent thread before it starts.
#[derive(Debug, Clone)]
pub struct ResolvedParent {
    pub thread_id: String,
    pub provider: String,
    pub cwd: String,
}

/// One child Code Flow: author executes, reviewer reviews, author revises.
#[derive(Debug, Clone)]
pub struct CodeFlowSpec {
    pub device_id: String,
    pub prompt: String,
    pub reviewer_provider: String,
    pub reviewer_model: Option<String>,
    pub reviewer_instructions: Option<String>,
    pub max_rounds: u32,
    pub parent_thread_id: Option<String>,
    pub anchor_item_id: String,
}

/// The relay capabilities a private orchestrator may use.
///
/// This is the whole of what the public side exposes to the private side — every
/// method is a deliberate grant. `relay-server` implements it for `AppState`.
///
/// Note what is NOT here: nothing that reads or writes an orchestrator's own run
/// records. Each engine owns its state entirely, which is what lets the public
/// build drop the engine without leaving dangling storage behind.
#[async_trait::async_trait]
pub trait RelayPort: Clone + Send + Sync + 'static {
    /// Held for the duration of a start, so guard checks and the record write are
    /// atomic against a concurrent start.
    type SessionSlot: Send;

    /// Release a controller lease whose holder went away, before guard checks read
    /// it.
    async fn expire_stale_controller_if_needed(&self);

    /// Reject unknown providers before anything is recorded.
    fn resolve_provider(&self, name: &str) -> Result<(), String>;

    fn acquire_session_slot(&self) -> Result<Self::SessionSlot, String>;

    /// Authorize the device against the parent thread and resolve it once.
    /// Also refuses when a concurrent workflow or review already owns the
    /// workspace.
    async fn authorize_and_resolve_workflow_parent(
        &self,
        device_id: &str,
        parent_thread_id: Option<String>,
    ) -> Result<ResolvedParent, String>;

    /// Start one child Code Flow. Returns its run id.
    ///
    /// This is the INTERNAL entry: it does not re-check the "an orchestrator is
    /// active" guard, because the caller is that orchestrator and it already owns
    /// the workspace.
    async fn start_code_flow(&self, spec: CodeFlowSpec) -> Result<String, String>;

    /// Block until child workflow `child_id` settles; return its status and the
    /// last verdict's `approved`.
    ///
    /// `Blocked` counts as settled — the child owns stuck threads and cannot make
    /// progress on its own. A vanished child reads as `Failed`.
    async fn wait_for_workflow(&self, child_id: &str) -> (RunStatus, Option<bool>);

    async fn push_log(&self, level: &str, message: String);

    /// Wake the snapshot stream.
    async fn notify(&self);
}

/// A private orchestrator, as the public relay sees it.
///
/// The relay never learns what an engine does — only whether it is busy, what it
/// has locked, and an opaque view/state blob to pass through to the snapshot and
/// the state file.
///
/// The lock questions carry default answers so an engine that owns no threads or
/// workspaces (an in-memory one, or one still being built out) implements only
/// what it actually enforces.
#[async_trait::async_trait]
pub trait Orchestrator: Send + Sync {
    /// Stable identifier, used as the persistence key and the routing segment.
    fn name(&self) -> &'static str;

    /// Whether any run is non-terminal. Guards mutually-exclusive starts.
    fn has_active(&self) -> bool;

    /// Whether a non-terminal run owns `thread_id` — any seat it drives.
    fn is_thread_locked(&self, _thread_id: &str) -> bool {
        false
    }

    /// Whether a non-terminal run owns the workspace at `cwd`.
    ///
    /// CONTAINMENT, not string equality: a thread started in `<worktree>/src` is
    /// in the very same git worktree, and exact matching would let precisely the
    /// writer this lock excludes in through a subdirectory.
    fn is_cwd_locked(&self, _cwd: &str) -> bool {
        false
    }

    /// The workspace of the non-terminal run that owns `thread_id` — the authority
    /// a user action on that thread is authorized against.
    fn run_cwd_for_thread(&self, _thread_id: &str) -> Option<String> {
        None
    }

    fn thread_gate(&self, _thread_id: &str) -> ThreadGate {
        ThreadGate::Free
    }

    /// Bumped whenever a view changes. The snapshot carries only this scalar; the
    /// client refetches the full view when it moves, so run payloads never ride
    /// the snapshot.
    fn revision(&self) -> u64 {
        0
    }

    /// The client-facing view of every run, opaque to the relay.
    fn views(&self) -> serde_json::Value {
        serde_json::Value::Null
    }

    /// This engine's state, to be written into the relay's state file under
    /// `name()`. Opaque: the relay stores and returns it without interpreting it.
    fn persist(&self) -> serde_json::Value {
        serde_json::Value::Null
    }

    /// Reinstate state previously returned by [`Orchestrator::persist`], and
    /// reconcile anything left stranded by the restart.
    ///
    /// Returns what could NOT be restored, one message per unusable record.
    ///
    /// Why a report and not a silent best-effort: with a typed field, a corrupt
    /// record failed the whole state-file decode — loud, and impossible to miss.
    /// Behind an opaque blob that check moves in here, so an engine that quietly
    /// swallowed a decode error would turn "the relay refused to start" into "your
    /// runs vanished". The relay logs whatever comes back.
    ///
    /// Per-record, deliberately: one bad run should cost that run, not the
    /// sessions and pairings sharing the same file.
    fn restore(&self, _state: serde_json::Value) -> Vec<String> {
        Vec::new()
    }
}

/// The engines a relay has registered.
///
/// A thin newtype rather than a bare `Vec` so the lock questions read the same at
/// every call site, and so "no engines registered" — the public build — answers
/// them all correctly and cheaply.
#[derive(Default, Clone)]
pub struct Orchestrators(std::sync::Arc<Vec<std::sync::Arc<dyn Orchestrator>>>);

impl Orchestrators {
    pub fn new(engines: Vec<std::sync::Arc<dyn Orchestrator>>) -> Self {
        Self(std::sync::Arc::new(engines))
    }

    pub fn get(&self, name: &str) -> Option<&std::sync::Arc<dyn Orchestrator>> {
        self.0.iter().find(|engine| engine.name() == name)
    }

    pub fn iter(&self) -> impl Iterator<Item = &std::sync::Arc<dyn Orchestrator>> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn has_active(&self) -> bool {
        self.0.iter().any(|engine| engine.has_active())
    }

    pub fn is_thread_locked(&self, thread_id: &str) -> bool {
        self.0
            .iter()
            .any(|engine| engine.is_thread_locked(thread_id))
    }

    pub fn is_cwd_locked(&self, cwd: &str) -> bool {
        self.0.iter().any(|engine| engine.is_cwd_locked(cwd))
    }

    pub fn run_cwd_for_thread(&self, thread_id: &str) -> Option<String> {
        self.0
            .iter()
            .find_map(|engine| engine.run_cwd_for_thread(thread_id))
    }

    /// The most restrictive answer any engine gives.
    ///
    /// `Locked` wins over `ConversableWhileParked`: if one engine is actively
    /// driving the thread, another engine's parked seat does not make it safe to
    /// type into.
    pub fn thread_gate(&self, thread_id: &str) -> ThreadGate {
        let mut gate = ThreadGate::Free;
        for engine in self.0.iter() {
            match engine.thread_gate(thread_id) {
                ThreadGate::Locked => return ThreadGate::Locked,
                ThreadGate::ConversableWhileParked => gate = ThreadGate::ConversableWhileParked,
                ThreadGate::Free => {}
            }
        }
        gate
    }
}

impl std::fmt::Debug for Orchestrators {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.0.iter().map(|engine| engine.name()))
            .finish()
    }
}

/// A mechanism failure returned across the task-team seam.
///
/// The public side classifies the failure but does not settle or log the run;
/// the private driver owns that single state transition. `Settled` is the
/// expected race where a user action won while an operation was waiting for a
/// gate and therefore needs no second report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamPortError {
    Blocked(String),
    Failed(String),
    Settled,
}

/// Public mechanisms granted to the private task-team driver.
///
/// Product order, phase transitions, prompts, parsing, and retry decisions do
/// not belong here. This surface is intentionally limited to durable-record
/// access and auditable thread/worktree operations implemented by the relay.
/// A seat the executor started or resumed, already registered as run-owned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamSeat {
    pub thread_id: String,
    pub slot: team::TeamThreadSlot,
}

#[async_trait::async_trait]
pub trait TeamPort: Send + Sync {
    async fn run_snapshot(&self, run_id: &str) -> Option<team::TeamRun>;
    /// Validate and apply one local state command (T4) — see `team_command`
    /// and `.sealwire/DESIGN.md`. `None` means `run_id` names no run; every
    /// other outcome, including every rejection, is a `Some` receipt.
    async fn submit_command(
        &self,
        run_id: &str,
        envelope: team_command::TeamCommandEnvelope,
    ) -> Option<team_command::TeamCommandReceipt>;

    /// Whether a user action or settlement means this run may no longer be
    /// driven. A read: the driver enacts the answer by submitting a
    /// `SettleRun` command, which is the only way state changes.
    async fn boundary_status(&self, run_id: &str) -> Option<team::TeamRunStatus>;

    async fn tl_reseed_reason(&self, run_id: &str) -> Option<String>;
    async fn reseed_tl(
        &self,
        run_id: &str,
        reason: &str,
        handover_prompt: String,
    ) -> Result<(), TeamPortError>;
    async fn tl_turn(&self, run_id: &str, prompt: String) -> team::TeamTurnOutcome;

    async fn require_workspace(&self, run_id: &str) -> Result<(), TeamPortError>;
    /// Start a seat and register it as run-owned, returning both its id and
    /// the slot it now occupies.
    ///
    /// Registration is an executor mechanism, not a driver decision, so it
    /// stays on this side of the seam and is done here rather than left for
    /// the driver to request separately — a seat that exists but is not owned
    /// is a leak the driver should not be able to create.
    async fn start_thread(
        &self,
        run_id: &str,
        role: team::TeamRole,
    ) -> Result<TeamSeat, TeamPortError>;
    /// The first of `candidates` that can still take a turn, else a new seat.
    ///
    /// Ordered, so a dead first choice falls through to a live second. "Take a
    /// turn", not "read history" — agents refuse the latter for live sessions.
    async fn resume_or_start_thread(
        &self,
        run_id: &str,
        role: team::TeamRole,
        candidates: &[String],
    ) -> Result<TeamSeat, TeamPortError>;
    async fn turn(
        &self,
        run_id: &str,
        slot: team::TeamThreadSlot,
        role: team::TeamRole,
        prompt: &str,
    ) -> team::TeamTurnOutcome;

    async fn checkpoint_commit(&self, run_id: &str) -> Result<Option<String>, TeamPortError>;
    async fn current_head_sha(&self, run_id: &str) -> Result<String, TeamPortError> {
        let _ = run_id;
        Err(TeamPortError::Failed(
            "current HEAD collection is unavailable".to_string(),
        ))
    }

    /// Freeze the worktree state that should be reviewed after a developer
    /// round. Implementations may return HEAD or an immutable hidden checkpoint
    /// when the worktree is dirty; neither choice may mutate branch history.
    async fn capture_review_candidate(
        &self,
        run_id: &str,
        slot: team::TeamThreadSlot,
        round_base_sha: &str,
    ) -> Result<Option<String>, TeamPortError> {
        let _ = slot;
        let head = self.current_head_sha(run_id).await?;
        Ok((head != round_base_sha).then_some(head))
    }

    async fn collect_review_target(
        &self,
        run_id: &str,
        base_sha: &str,
        candidate_sha: &str,
    ) -> Result<GitReviewTarget, TeamPortError> {
        let _ = (run_id, base_sha, candidate_sha);
        Err(TeamPortError::Failed(
            "committed review target collection is unavailable".to_string(),
        ))
    }
    async fn collect_diff(&self, run_id: &str, base: Option<&str>)
        -> Result<String, TeamPortError>;
    async fn merge_base(
        &self,
        run_id: &str,
        target_ref: &str,
    ) -> Result<Option<String>, TeamPortError>;
    async fn commit(&self, run_id: &str, message: &str) -> Result<bool, TeamPortError>;
    async fn push_log(&self, level: &'static str, message: String);
}

/// The proprietary workflow runner registered by a full build.
///
/// A public build has no implementation and therefore cannot start a team. The
/// driver receives only [`TeamPort`], never `relay-server::AppState`.
#[async_trait::async_trait]
pub trait TeamDriver: Send + Sync {
    /// Standing instructions for the public Orchestrator chat thread. This is the
    /// only private wording the relay must carry outside a task run; every task
    /// prompt and parser remains an implementation detail of the driver.
    fn orchestrator_system_prompt(&self) -> String;

    /// Monotonic persona version persisted beside the pinned prompt.
    fn orchestrator_system_prompt_version(&self) -> u32 {
        0
    }

    /// Drive until the workflow reaches a boundary. The public host reconciles
    /// the run after this future returns or unwinds, so an implementation cannot
    /// leave a permanently `Running` record by forgetting private cleanup.
    async fn drive(&self, port: std::sync::Arc<dyn TeamPort>, run_id: String);
}

#[cfg(test)]
mod team_port_error_tests {
    use super::TeamPortError;
    use serde::Serialize;

    /// `TeamPortError`'s `String` payloads are local diagnostic prose (see its
    /// doc comment). Having no `Serialize` impl is what keeps that prose out of
    /// the journal and the Cloud wire format; pin it so a future
    /// `#[derive(Serialize)]` fails a build instead of silently widening the
    /// seam.
    #[test]
    fn team_port_error_has_no_serialize_impl() {
        struct Probe<T>(std::marker::PhantomData<T>);
        trait NotSerializable {
            fn holds() -> bool {
                true
            }
        }
        impl<T> NotSerializable for Probe<T> {}
        #[allow(dead_code)]
        trait IsSerializable {
            fn holds() -> bool {
                false
            }
        }
        impl<T: Serialize> IsSerializable for Probe<T> {}

        assert!(Probe::<TeamPortError>::holds());
    }
}
