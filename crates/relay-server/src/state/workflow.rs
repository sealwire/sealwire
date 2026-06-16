//! Relay-owned projection of a multi-step agent workflow.
//!
//! A `Workflow` is a reusable, saved pipeline of agent steps. Each step runs a
//! provider (`claude` / `codex` / `fake`) in a role (execute / review / revise)
//! against a shared artifact (a working-tree diff, or a design doc). A `LoopSpec`
//! repeats a review/revise pair up to `max_rounds` until the reviewer approves.
//!
//! A `WorkflowRun` is one execution. Unlike `ReviewJob` (which persists only
//! TERMINAL jobs), a run persists while NON-terminal too — that is the whole
//! point of "the task just sits there." Because a persisted run has no live
//! orchestrator after a restart, the restore side reconciles every non-terminal
//! run to the terminal `Interrupted` state (deterministic fail-and-re-run, not
//! resume); a `WorkflowRunLifeguard` does the same on mid-session task death.
//!
//! Phase 1 supports a linear pipeline + one loop construct; the free-form graph
//! editor and per-run worktree isolation are phase 2. See
//! `markdown/workflow-runner-design.md`.

// Phase-1 workflow projection: implemented and unit-tested below, but not yet
// referenced by a live (non-test) code path, so its types/methods read as dead in a
// normal build. Suppress module-wide until the runner is wired to the handlers.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::unix_now;

/// The artifact a workflow produces and reviews. Code Flow mutates the working
/// tree (`Diff`); Design Flow writes a markdown doc (`DesignDoc`). Same engine,
/// different payload type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactKind {
    #[default]
    Diff,
    DesignDoc,
}

/// What a step does to the shared artifact. One `WorkflowStep` == one "box" in
/// the diagram.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StepRole {
    #[default]
    Execute,
    Review,
    Revise,
}

/// How the loop decides it is done. `ReviewerApproved` (the primary, fully
/// supported stop) ends as soon as a review step's structured verdict is
/// `approved`. `NoNewFindings` is provisional: it requires a stable finding
/// identity model (see `FindingSet`) that is an open question in the design doc,
/// so phase 1 ships `ReviewerApproved` as the default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StopCondition {
    #[default]
    ReviewerApproved,
    NoNewFindings,
}

/// One step in a workflow pipeline. User-editable in phase 2; for phase 1 the two
/// built-in templates supply these.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct WorkflowStep {
    pub(crate) id: String,
    /// Provider key the step runs on: `claude_code` / `codex` / `fake`.
    pub(crate) agent: String,
    pub(crate) role: StepRole,
    /// Optional per-step model override; `None` uses the thread/session default.
    pub(crate) model: Option<String>,
    /// Prompt template. May contain `{artifact}` / `{review}` slots the runner
    /// fills in. Empty means the role's built-in default prompt is used.
    pub(crate) prompt: String,
}

/// The repeating part of a workflow: re-run `[from_step, to_step]` up to
/// `max_rounds` until `stop_when` is satisfied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LoopSpec {
    pub(crate) from_step: String,
    pub(crate) to_step: String,
    pub(crate) max_rounds: u32,
    pub(crate) stop_when: StopCondition,
}

/// A reusable, saved workflow template. Phase 1 ships two built-ins (Code Flow,
/// Design Flow); user-authored templates are phase 2.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Workflow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) artifact: ArtifactKind,
    pub(crate) steps: Vec<WorkflowStep>,
    pub(crate) loop_: Option<LoopSpec>,
}

/// A review step's machine-readable result. This is the "structured verdict"
/// shape decided in the design doc; phase 1 derives it from the reviewer's text
/// (reusing the existing `VERDICT:` parsing). How a real provider is made to emit
/// this directly (required tool call vs. parse-last-message) is open for chunk
/// 2/3 — `fake_provider` returns it deterministically for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WorkflowVerdict {
    pub(crate) approved: bool,
    pub(crate) summary: Option<String>,
    pub(crate) findings: Vec<String>,
}

impl WorkflowVerdict {
    pub(crate) fn approved() -> Self {
        Self {
            approved: true,
            summary: None,
            findings: Vec::new(),
        }
    }

    pub(crate) fn needs_changes(findings: Vec<String>) -> Self {
        Self {
            approved: false,
            summary: None,
            findings,
        }
    }
}

/// Normalized identity keys for a round's findings, used by the (provisional)
/// `NoNewFindings` stop condition to tell whether a re-review surfaced anything
/// new. The identity model is intentionally simple (and flagged as an open
/// question in the design doc): two findings are "the same" iff their normalized
/// text matches. `ReviewerApproved` does not use this.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FindingSet {
    pub(crate) keys: Vec<String>,
}

impl FindingSet {
    pub(crate) fn from_findings(findings: &[String]) -> Self {
        let mut keys: Vec<String> = findings.iter().map(|f| normalize_finding(f)).collect();
        keys.sort();
        keys.dedup();
        Self { keys }
    }

    /// Whether `self` (this round) contains a finding identity not present in
    /// `prior` — i.e. the re-review surfaced something new.
    pub(crate) fn has_new_relative_to(&self, prior: &FindingSet) -> bool {
        self.keys.iter().any(|k| !prior.keys.contains(k))
    }
}

/// Provisional finding-identity normalization: lowercase + collapse whitespace.
/// TODO(workflow phase 2): a real identity model (file:line anchoring, fuzzy
/// match) — naive text equality rarely repeats verbatim across rounds.
fn normalize_finding(finding: &str) -> String {
    finding
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Lifecycle of a single workflow run. Terminal states are `Done`, `Escalated`,
/// `Failed`, `Interrupted`, and `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RunStatus {
    /// Recorded, orchestrator not yet started.
    Queued,
    /// The serial runner is driving steps (which step is shown via
    /// `WorkflowRun::current_step` + the step's role).
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
    /// The run's orchestrator was lost (relay restart, or mid-session task death)
    /// while still non-terminal. The restore/lifeguard path reconciles to this so
    /// the run is never persisted `Running` with no driver. TERMINAL — the card
    /// offers a one-tap re-run from the last completed step. TREE STATE IS NOT
    /// RESTORED (see design §5): an interrupted Code Flow may leave a dirty tree.
    Interrupted,
    /// The user stopped the run before it finished. TERMINAL.
    Cancelled,
}

impl RunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Done => "done",
            RunStatus::Escalated => "escalated",
            RunStatus::Failed => "failed",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Cancelled => "cancelled",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
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

/// One execution of a `Workflow`. Holds only orchestration metadata; each step's
/// real agent output lives in the background thread referenced by `step_threads`.
///
/// `Default` + `#[serde(default)]` give persistence forward-compat (a run written
/// by a future build that adds a field still decodes here). NON-terminal runs ARE
/// persisted (unlike `ReviewJob`); the restore side reconciles them to
/// `Interrupted` via `mark_interrupted_if_stranded`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct WorkflowRun {
    pub(crate) id: String,
    pub(crate) workflow_id: String,
    pub(crate) parent_thread_id: String,
    /// The provider transcript entry the run was triggered from; the frontend
    /// positions the card after it (with a bottom-fallback when it is compacted
    /// out of the snapshot). See design §6.2.
    pub(crate) anchor_item_id: String,
    pub(crate) status: RunStatus,
    /// The id of the step currently running (drives the per-node "Codex
    /// reviewing…" label together with the step's role). Empty when queued/done.
    pub(crate) current_step: String,
    /// Completed review rounds so far (0 until the first review lands).
    pub(crate) round: u32,
    /// step_id -> background thread id carrying that step's sub-transcript.
    pub(crate) step_threads: HashMap<String, String>,
    /// The latest review step's structured verdict (NOT a growing Vec — keeping
    /// only the last bounds the snapshot view; see design §3/§6).
    pub(crate) last_verdict: Option<WorkflowVerdict>,
    /// Prior-round finding identities, retained only when the loop uses
    /// `StopCondition::NoNewFindings`.
    pub(crate) prior_findings: Option<FindingSet>,
    pub(crate) cwd: String,
    pub(crate) requested_by_device_id: String,
    pub(crate) requested_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) error: Option<String>,
}

impl WorkflowRun {
    pub(crate) fn new(
        id: String,
        workflow_id: String,
        parent_thread_id: String,
        anchor_item_id: String,
        cwd: String,
        requested_by_device_id: String,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            workflow_id,
            parent_thread_id,
            anchor_item_id,
            status: RunStatus::Queued,
            current_step: String::new(),
            round: 0,
            step_threads: HashMap::new(),
            last_verdict: None,
            prior_findings: None,
            cwd,
            requested_by_device_id,
            requested_at: now,
            updated_at: now,
            error: None,
        }
    }

    /// Advance the run's status. Terminal is final: once `Done`/`Escalated`/
    /// `Failed`/`Interrupted`/`Cancelled`, a later write can never resurrect it —
    /// the same guard `ReviewJob` uses so a cancel/interrupt that won a race can't
    /// be clobbered by the orchestrator's next between-step write.
    pub(crate) fn set_status(&mut self, status: RunStatus) {
        if self.status.is_terminal() {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn set_current_step(&mut self, step_id: impl Into<String>) {
        self.current_step = step_id.into();
        self.updated_at = unix_now();
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.set_status(RunStatus::Failed);
    }

    /// Reconcile a run whose orchestrator is gone (restart / task death): if it is
    /// still non-terminal, drive it to the terminal `Interrupted` state and record
    /// why. Returns whether it changed (so the caller can unlock threads + log).
    /// A run that already settled is left untouched.
    pub(crate) fn mark_interrupted_if_stranded(&mut self) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.error.get_or_insert_with(|| {
            "the workflow run's orchestrator was lost; re-run to continue".to_string()
        });
        self.status = RunStatus::Interrupted;
        self.updated_at = unix_now();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_run() -> WorkflowRun {
        WorkflowRun::new(
            "run-1".to_string(),
            "code-flow".to_string(),
            "parent-1".to_string(),
            "item-1".to_string(),
            "/tmp".to_string(),
            "device-1".to_string(),
        )
    }

    #[test]
    fn terminal_status_is_never_resurrected() {
        // Mirrors the review terminal-guard: a cancel/interrupt that reached a
        // terminal state must survive the orchestrator's next between-step write.
        for terminal in [
            RunStatus::Done,
            RunStatus::Escalated,
            RunStatus::Failed,
            RunStatus::Interrupted,
            RunStatus::Cancelled,
        ] {
            let mut run = sample_run();
            run.set_status(RunStatus::Running);
            run.set_status(terminal);
            assert_eq!(run.status, terminal);

            run.set_status(RunStatus::Running);
            assert_eq!(
                run.status, terminal,
                "a terminal run ({terminal:?}) was resurrected by a later status write",
            );
        }
    }

    #[test]
    fn interrupt_only_strands_non_terminal_runs() {
        // A running run is reconciled to Interrupted...
        let mut run = sample_run();
        run.set_status(RunStatus::Running);
        assert!(run.mark_interrupted_if_stranded());
        assert_eq!(run.status, RunStatus::Interrupted);
        assert!(run.error.is_some());

        // ...and is then idempotent (already terminal -> no change).
        assert!(!run.mark_interrupted_if_stranded());

        // An already-Done run is left untouched (not downgraded to Interrupted).
        let mut done = sample_run();
        done.set_status(RunStatus::Done);
        assert!(!done.mark_interrupted_if_stranded());
        assert_eq!(done.status, RunStatus::Done);
        assert!(done.error.is_none());
    }

    #[test]
    fn fail_does_not_override_a_terminal_state() {
        let mut run = sample_run();
        run.set_status(RunStatus::Running);
        run.set_status(RunStatus::Cancelled);
        run.fail("the workflow task ended unexpectedly");
        assert_eq!(run.status, RunStatus::Cancelled);
        assert!(run.error.is_none());
    }

    #[test]
    fn no_new_findings_identity_is_whitespace_and_case_insensitive() {
        let round1 = FindingSet::from_findings(&[
            "Null deref in  foo.rs".to_string(),
            "Missing test for bar".to_string(),
        ]);
        // Reworded only by whitespace/case -> not "new".
        let round2 = FindingSet::from_findings(&[
            "null deref in foo.rs".to_string(),
            "MISSING TEST FOR BAR".to_string(),
        ]);
        assert!(!round2.has_new_relative_to(&round1));

        // A genuinely new finding is detected.
        let round3 = FindingSet::from_findings(&[
            "null deref in foo.rs".to_string(),
            "race in baz".to_string(),
        ]);
        assert!(round3.has_new_relative_to(&round1));
    }

    #[test]
    fn missing_status_decodes_to_failed_terminal() {
        // `#[serde(default)]` forward-compat (load-bearing for the persistence
        // chunk): a persisted run written without `status` — an older build, or a
        // truncated record — must decode to a SAFE terminal state, never a
        // non-terminal one that would strand a tree lock with no orchestrator.
        let json =
            r#"{"id":"run-1","workflow_id":"code-flow","parent_thread_id":"p","cwd":"/tmp"}"#;
        let run: WorkflowRun = serde_json::from_str(json).expect("decode run missing status");
        assert_eq!(run.status, RunStatus::Failed);
        assert!(run.status.is_terminal());
    }

    #[test]
    fn run_status_as_str_matches_serde_wire_format() {
        // `as_str()` and `#[serde(rename_all = "snake_case")]` are hand-maintained
        // in two places; assert they agree so logs/UI can't silently drift from the
        // persisted/snapshot wire format.
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Done,
            RunStatus::Escalated,
            RunStatus::Failed,
            RunStatus::Interrupted,
            RunStatus::Cancelled,
        ] {
            let serialized = serde_json::to_value(status).expect("serialize status");
            assert_eq!(
                serde_json::Value::String(status.as_str().to_string()),
                serialized,
                "as_str() disagrees with the serde wire format for {status:?}",
            );
        }
    }
}
