//! Local idempotent command family for task-team run state (T4).
//!
//! Sibling to, and deliberately separate from, `orchestration::DriverCommand`:
//! that enum is the future Cloud **executor** protocol — content-blind and
//! golden-pinned. The commands here carry real prose (findings, summaries,
//! commit shas, thread ids) because there is no artifact store to put it in
//! until T5, which is expected to replace every such field with an
//! `ArtifactRef` (marked below) and fold this module into the content-blind
//! family. Until then: **local-only.** A `TeamCommandEnvelope` is never
//! serialized to `TeamRun.command_journal` and never sent anywhere off this
//! relay — see `orchestration::TeamCommandRecord` for the content-blind
//! projection that IS journaled, and `.sealwire/DESIGN.md` D1/D3.
//!
//! The reducer that validates and applies these lives in `relay-server`
//! (it needs `sha2` for the command fingerprint); this module holds only the
//! closed vocabulary.

use serde::Serialize;

use crate::orchestration::{CommandId, CommandRejection, TeamCommandKind};
use crate::team::{SubTask, SubTaskStatus, TeamPauseKind, TeamPhase, TeamRunStatus};
use crate::WorkflowVerdict;

/// Local command protocol version. Independent of
/// `orchestration::CURRENT_PROTOCOL_VERSION`: that number tracks the future
/// Cloud wire format, this one tracks this in-process seam.
pub const TEAM_COMMAND_PROTOCOL_VERSION: u32 = 1;

/// Hard ceiling on `ReplanSubTasks.sub_tasks`. Bounds the count, not the
/// prose in each sub-task's brief — that prose is already stored unbounded on
/// `TeamRun` and never reaches the journal, so a byte cap would buy no
/// privacy while adding a new way for a real run to fail. Picked well above
/// anything today's driver produces; if it ever bites a real run that is a
/// behaviour regression, not a safety win (`.sealwire/DESIGN.md` D6).
pub const MAX_TEAM_COMMAND_SUB_TASKS: usize = 64;
/// Hard ceiling on a single command's findings/unresolved-additions list.
/// Same rationale as [`MAX_TEAM_COMMAND_SUB_TASKS`].
pub const MAX_TEAM_COMMAND_FINDINGS: usize = 64;
/// Hard ceiling on `TeamRun.pending_user_notes.len()` at the moment a
/// `TakeUserNotes` command drains it. Bounds refuse rather than truncate: a
/// truncated drain would silently drop a user's note.
pub const MAX_TEAM_COMMAND_NOTES: usize = 64;

/// Hard ceiling on one command's total serialized size.
///
/// The collection counts above bound how MANY items a command carries; this
/// bounds how big it is, which nothing else does — a single findings entry or
/// result summary can be arbitrarily long on its own. Deliberately far above
/// any real turn's output (a whole review reply is a few KiB) so it only ever
/// catches a runaway, never a genuine run — see `.sealwire/DESIGN.md` D6.
pub const MAX_TEAM_COMMAND_PAYLOAD_BYTES: usize = 1 << 20;

/// A sub-task seat a command may attach a thread to. Never `Tl` — the TL
/// thread's identity moves through `RecordIntake`'s succession mechanics, not
/// a seat attach, so this enum structurally cannot name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamSubTaskRole {
    Dev,
    Reviewer,
}

/// Command envelope with stable identity, ordering, and the revision the
/// sender last observed. Mirrors `orchestration::DriverCommandEnvelope`'s
/// shape deliberately — same idempotency pattern, different privacy class.
#[derive(Debug, Clone, Serialize)]
pub struct TeamCommandEnvelope {
    pub protocol_version: u32,
    pub command_id: CommandId,
    pub sequence: u64,
    pub expected_revision: u64,
    pub command: TeamStateCommand,
}

/// The closed set of state mutations a task-team driver may ask the local
/// reducer to apply. Every variant is typed and bounded; none carries
/// `serde_json::Value` or an unconstrained closure. See
/// `.sealwire/DESIGN.md` D11 for the mapping from each private driver call
/// site to the variant that replaces it.
///
/// A command never carries the DECISION that produced it (which phase, which
/// verdict, whether a budget is exhausted) as logic — only as an already-made
/// value. The driver reads a snapshot, decides, and sends the result; the
/// reducer only validates and applies. Product policy stays entirely in
/// `sealwire-private`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TeamStateCommand {
    RecordIntake {
        complex: bool,
        phase: TeamPhase,
    },
    SetPhase {
        phase: TeamPhase,
    },
    RecordDesignReviewRound {
        // T5: → ArtifactRef
        verdict: WorkflowVerdict,
        next_phase: TeamPhase,
        // T5: → ArtifactRef
        unresolved_additions: Vec<String>,
    },
    ReplanSubTasks {
        // T5: → ArtifactRef
        sub_tasks: Vec<SubTask>,
        phase: TeamPhase,
    },
    AttachSubTaskThread {
        index: usize,
        role: TeamSubTaskRole,
        // T5: → ArtifactRef
        thread_id: String,
        // T5: → ArtifactRef
        base_commit: Option<String>,
    },
    SetSubTaskStatus {
        index: usize,
        status: SubTaskStatus,
    },
    /// Park a developer round that produced no committed candidate without
    /// leaving stale candidate identity attached to the pending sub-task.
    PauseSubTaskWithoutCandidate {
        index: usize,
    },
    /// Count a review whose committed candidate changed before its verdict
    /// could be applied, so repeated rebound attempts remain bounded.
    RecordSubTaskStaleReview {
        index: usize,
    },
    RecordReviewRound {
        index: usize,
        // T5: → ArtifactRef
        verdict: WorkflowVerdict,
        status: SubTaskStatus,
        /// The DECIDED display string for `SubTask.result_summary`, which is
        /// not always `verdict.summary` verbatim (an escalation synthesizes
        /// its own message; an approval falls back to "Approved."). Carried
        /// separately so the reducer reproduces both fields exactly as the
        /// driver decided them.
        // T5: → ArtifactRef
        result_summary: Option<String>,
        // T5: → ArtifactRef
        escalated: Option<String>,
    },
    MarkSubTaskDigested {
        index: usize,
        next_phase: Option<TeamPhase>,
    },
    RecordMrRound {
        // T5: → ArtifactRef
        verdict: WorkflowVerdict,
        next_phase: Option<TeamPhase>,
        // T5: → ArtifactRef
        unresolved_additions: Vec<String>,
    },
    SetMrVerdict {
        // T5: → ArtifactRef
        verdict: Option<WorkflowVerdict>,
    },
    /// Pin the committed candidate reviewed by the next MR gate.
    PrepareMrReview {
        // T5: → ArtifactRef
        round_base_sha: String,
        // T5: → ArtifactRef
        candidate_sha: String,
    },
    /// Park an MR correction round that produced no committed candidate.
    PauseMrWithoutCandidate {
        // T5: → ArtifactRef
        verdict: WorkflowVerdict,
    },
    /// Count a stale MR verdict rebound attempt.
    RecordMrStaleReview {},
    RecordMrDevThread {
        // T5: → ArtifactRef
        thread_id: String,
    },
    FinishRun {
        // T5: → ArtifactRef
        head_commit: Option<String>,
        phase: TeamPhase,
    },
    /// Drain `TeamRun.pending_user_notes` atomically. See
    /// `.sealwire/DESIGN.md` D8 for why this is the one command whose receipt
    /// carries content, and why replay reads `TeamRun.drained_notes` rather
    /// than the (content-blind) journal.
    TakeUserNotes {},

    // -----------------------------------------------------------------
    // The lifecycle family (`.sealwire/DESIGN.md` D14). Everything above
    // records workflow progress; these four move the run's own status. They
    // exist so the driver has exactly ONE mutation seam — before T4 closed
    // it, these were four separate `TeamPort` methods that wrote state
    // outside the reducer entirely, unjournaled and unversioned.
    //
    // They are the one family exempt from the reducer's lifecycle gate,
    // because they ARE the transition it would refuse. Their own guards live
    // where they always did, on the `TeamRun` methods below.
    // -----------------------------------------------------------------
    /// Advance the run's status. `TeamRun::set_status`' guards still apply:
    /// terminal is final and a user-settled state is off-limits.
    SetRunStatus {
        status: TeamRunStatus,
    },
    /// Record a driver-observed failure. A DRAINING stop outranks it — see
    /// `TeamRun::fail`.
    FailRun {
        // T5: → ArtifactRef
        error: String,
    },
    /// Park the run for an explicit recovery, keeping its locks.
    BlockRun {
        // T5: → ArtifactRef
        error: String,
    },
    /// Write a settlement the driver reached at a step boundary. The
    /// quiescence pre-check that guards `Paused`/`Cancelled`/`Done` is a host
    /// mechanism and runs before this command is ever built.
    SettleRun {
        status: TeamRunStatus,
        // T5: → ArtifactRef
        reason: String,
        /// Named `pause_kind`, not `kind`: the envelope is serialized with an
        /// internally-tagged `kind` discriminant for the fingerprint, and a
        /// field of that name would collide with it.
        pause_kind: TeamPauseKind,
    },
}

impl TeamStateCommand {
    /// Whether this command carries the run's own lifecycle transition, and
    /// so must not be refused by the gate that protects workflow state from a
    /// stale driver decision. See the family's doc above.
    pub fn is_lifecycle_transition(&self) -> bool {
        matches!(
            self,
            Self::SetRunStatus { .. }
                | Self::FailRun { .. }
                | Self::BlockRun { .. }
                | Self::SettleRun { .. }
        )
    }

    /// The content-blind discriminant journaled for this command.
    pub fn kind(&self) -> TeamCommandKind {
        match self {
            Self::RecordIntake { .. } => TeamCommandKind::RecordIntake,
            Self::SetPhase { .. } => TeamCommandKind::SetPhase,
            Self::RecordDesignReviewRound { .. } => TeamCommandKind::RecordDesignReviewRound,
            Self::ReplanSubTasks { .. } => TeamCommandKind::ReplanSubTasks,
            Self::AttachSubTaskThread { .. } => TeamCommandKind::AttachSubTaskThread,
            Self::SetSubTaskStatus { .. } => TeamCommandKind::SetSubTaskStatus,
            Self::PauseSubTaskWithoutCandidate { .. } => {
                TeamCommandKind::PauseSubTaskWithoutCandidate
            }
            Self::RecordSubTaskStaleReview { .. } => TeamCommandKind::RecordSubTaskStaleReview,
            Self::RecordReviewRound { .. } => TeamCommandKind::RecordReviewRound,
            Self::MarkSubTaskDigested { .. } => TeamCommandKind::MarkSubTaskDigested,
            Self::RecordMrRound { .. } => TeamCommandKind::RecordMrRound,
            Self::SetMrVerdict { .. } => TeamCommandKind::SetMrVerdict,
            Self::PrepareMrReview { .. } => TeamCommandKind::PrepareMrReview,
            Self::PauseMrWithoutCandidate { .. } => TeamCommandKind::PauseMrWithoutCandidate,
            Self::RecordMrStaleReview {} => TeamCommandKind::RecordMrStaleReview,
            Self::RecordMrDevThread { .. } => TeamCommandKind::RecordMrDevThread,
            Self::FinishRun { .. } => TeamCommandKind::FinishRun,
            Self::TakeUserNotes {} => TeamCommandKind::TakeUserNotes,
            Self::SetRunStatus { .. } => TeamCommandKind::SetRunStatus,
            Self::FailRun { .. } => TeamCommandKind::FailRun,
            Self::BlockRun { .. } => TeamCommandKind::BlockRun,
            Self::SettleRun { .. } => TeamCommandKind::SettleRun,
        }
    }
}

/// What the reducer actually produced, for the one command whose receipt
/// carries content. Every other command's applied receipt is `Ack`: the
/// driver already knows what it asked for and the journal is content-blind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamCommandOutput {
    Ack,
    /// The notes drained by `TeamStateCommand::TakeUserNotes`.
    // T5: → ArtifactRef
    DrainedNotes(Vec<String>),
}

/// What happened to one submitted command. Local-only, unlike
/// `orchestration::TeamCommandOutcome`, which this is derived from plus
/// whatever content the specific command produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamCommandStatus {
    Applied(TeamCommandOutput),
    Rejected(CommandRejection),
    /// The command was in flight when the relay restarted; replayed from a
    /// restored journal record, never produced live by this build's
    /// synchronous reducer. See `.sealwire/DESIGN.md` D10.
    Interrupted,
}

/// Synchronous reply to one [`TeamCommandEnvelope`]. There is no event bus in
/// T4 — see `.sealwire/DESIGN.md` D4 for why a receipt replaces the
/// commands-or-events choice the brief allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamCommandReceipt {
    pub command_id: CommandId,
    pub sequence: u64,
    /// `TeamRun.driver_progress.state_revision` as it stands after this call,
    /// whether or not this command was the one that moved it.
    pub state_revision: u64,
    /// `TeamRun.driver_progress.last_event_seq` as it stands after this call.
    /// Counts receipts for APPLIED commands only — see D4's doc note on why
    /// this and `last_command_seq` are allowed to diverge.
    pub last_event_seq: u64,
    pub status: TeamCommandStatus,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{SubTask, SubTaskStatus, TeamPauseKind, TeamPhase, TeamRunStatus};
    use crate::WorkflowVerdict;

    fn one_of_every_variant() -> Vec<TeamStateCommand> {
        vec![
            TeamStateCommand::RecordIntake {
                complex: true,
                phase: TeamPhase::Design,
            },
            TeamStateCommand::SetPhase {
                phase: TeamPhase::Planning,
            },
            TeamStateCommand::RecordDesignReviewRound {
                verdict: WorkflowVerdict::approved(),
                next_phase: TeamPhase::Planning,
                unresolved_additions: vec!["finding".to_string()],
            },
            TeamStateCommand::ReplanSubTasks {
                sub_tasks: vec![SubTask::default()],
                phase: TeamPhase::SubTasks,
            },
            TeamStateCommand::AttachSubTaskThread {
                index: 0,
                role: TeamSubTaskRole::Dev,
                thread_id: "thread-1".to_string(),
                base_commit: Some("deadbeef".to_string()),
            },
            TeamStateCommand::SetSubTaskStatus {
                index: 0,
                status: SubTaskStatus::Implementing,
            },
            TeamStateCommand::PauseSubTaskWithoutCandidate { index: 0 },
            TeamStateCommand::RecordSubTaskStaleReview { index: 0 },
            TeamStateCommand::RecordReviewRound {
                index: 0,
                verdict: WorkflowVerdict::approved(),
                status: SubTaskStatus::Done,
                result_summary: Some("Approved.".to_string()),
                escalated: None,
            },
            TeamStateCommand::MarkSubTaskDigested {
                index: 0,
                next_phase: Some(TeamPhase::MrGate),
            },
            TeamStateCommand::RecordMrRound {
                verdict: WorkflowVerdict::approved(),
                next_phase: Some(TeamPhase::Wrapping),
                unresolved_additions: vec!["finding".to_string()],
            },
            TeamStateCommand::SetMrVerdict {
                verdict: Some(WorkflowVerdict::approved()),
            },
            TeamStateCommand::PrepareMrReview {
                round_base_sha: "base".to_string(),
                candidate_sha: "candidate".to_string(),
            },
            TeamStateCommand::PauseMrWithoutCandidate {
                verdict: WorkflowVerdict::needs_changes(vec!["commit first".to_string()]),
            },
            TeamStateCommand::RecordMrStaleReview {},
            TeamStateCommand::RecordMrDevThread {
                thread_id: "mr-dev".to_string(),
            },
            TeamStateCommand::FinishRun {
                head_commit: Some("cafebabe".to_string()),
                phase: TeamPhase::Finished,
            },
            TeamStateCommand::TakeUserNotes {},
        ]
    }

    /// AC-1's backend-immutability guarantee is structural, not a checked
    /// branch: no `TeamStateCommand` variant has a field that could name an
    /// orchestration backend, so there is no rejection path to test — only a
    /// shape to prove absent. Walks every variant's full JSON serialization
    /// (which is exactly its field set, since this enum carries no opaque
    /// `serde_json::Value`) and asserts no key even mentions "backend".
    #[test]
    fn no_team_state_command_variant_can_name_an_orchestration_backend() {
        fn assert_no_backend_key(value: &serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, inner) in map {
                        assert!(
                            !key.to_lowercase().contains("backend"),
                            "a local state command must never be able to name a backend, found key {key:?}"
                        );
                        assert_no_backend_key(inner);
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        assert_no_backend_key(item);
                    }
                }
                serde_json::Value::Null
                | serde_json::Value::Bool(_)
                | serde_json::Value::Number(_)
                | serde_json::Value::String(_) => {}
            }
        }

        for command in one_of_every_variant() {
            let value = serde_json::to_value(&command).expect("every command serializes");
            assert_no_backend_key(&value);
        }
    }

    /// D11's mapping is exhaustive over the 14 private call sites this
    /// replaces; `kind()` must stay total as the enum grows, which this
    /// exercises by round-tripping every variant rather than by inspection.
    #[test]
    fn every_command_variant_has_a_content_blind_kind() {
        use crate::orchestration::TeamCommandKind;

        let expected = [
            TeamCommandKind::RecordIntake,
            TeamCommandKind::SetPhase,
            TeamCommandKind::RecordDesignReviewRound,
            TeamCommandKind::ReplanSubTasks,
            TeamCommandKind::AttachSubTaskThread,
            TeamCommandKind::SetSubTaskStatus,
            TeamCommandKind::PauseSubTaskWithoutCandidate,
            TeamCommandKind::RecordSubTaskStaleReview,
            TeamCommandKind::RecordReviewRound,
            TeamCommandKind::MarkSubTaskDigested,
            TeamCommandKind::RecordMrRound,
            TeamCommandKind::SetMrVerdict,
            TeamCommandKind::PrepareMrReview,
            TeamCommandKind::PauseMrWithoutCandidate,
            TeamCommandKind::RecordMrStaleReview,
            TeamCommandKind::RecordMrDevThread,
            TeamCommandKind::FinishRun,
            TeamCommandKind::TakeUserNotes,
        ];
        let commands = one_of_every_variant();
        assert_eq!(commands.len(), expected.len());
        for (command, kind) in commands.iter().zip(expected.iter()) {
            assert_eq!(&command.kind(), kind);
        }
    }
}
