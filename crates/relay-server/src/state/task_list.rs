//! Long task-list runner model (phase 2).
//!
//! A `TaskList` is an ordered list of tasks. Each task runs exactly ONE Code Flow
//! (author execute → reviewer review → author revise, phase 1 `WorkflowRun`) — the
//! "two-as-a-group" pairing: one author agent + one reviewer agent per task. The
//! list driver runs tasks **serially**: start a child workflow, wait for it to
//! reach a terminal status, checkpoint, then advance to the next task. Because a
//! `TaskListRun` can "just sit there" across a long autonomous iteration, it is
//! persisted while NON-terminal too (like `WorkflowRun`, unlike `ReviewJob`); the
//! restore side reconciles a stranded run to the terminal `Interrupted` state
//! (deterministic fail-and-re-run from the last completed task, not resume).
//!
//! This module is the DATA MODEL only (brick 1). The serial driver, protocol
//! view, git checkpointing, and UI land in later bricks. See
//! `markdown/task-list-runner-design.md`.

// Later bricks (driver / protocol view / UI) consume these; keep the model ahead
// of its wiring without dead-code warnings, mirroring `state/workflow.rs`.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::unix_now;
use super::workflow::RunStatus;

/// What the list does when a task's Code Flow ends `Escalated` (the reviewer never
/// approved within the round budget). `Halt` (default) stops the list and surfaces
/// it for a human — later tasks should not build on code a reviewer rejected.
/// `Continue` records the escalation and moves on (best-effort long iteration).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EscalatePolicy {
    #[default]
    Halt,
    Continue,
}

/// Whether the driver checkpoints the working tree after each `Done` task. `Commit`
/// (default) git-commits the approved work so the next task's review sees only its
/// OWN diff and a restart can re-run from a clean point. `None` leaves the tree as
/// is, so each task reviews the cumulative diff since the run started.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CheckpointMode {
    #[default]
    Commit,
    None,
}

/// Per-task lifecycle within a list run. Terminal task states are `Done`,
/// `Escalated`, `Failed`, and `Skipped`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskStatus {
    /// Not started yet.
    #[default]
    Pending,
    /// Its Code Flow is running.
    Running,
    /// The reviewer approved this task's Code Flow. TERMINAL.
    Done,
    /// The Code Flow hit its round budget without approval. TERMINAL.
    Escalated,
    /// The Code Flow failed (e.g. produced no output, or an error). TERMINAL.
    Failed,
    /// Not run because the list halted before reaching it. TERMINAL.
    Skipped,
}

impl TaskStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Running => "running",
            TaskStatus::Done => "done",
            TaskStatus::Escalated => "escalated",
            TaskStatus::Failed => "failed",
            TaskStatus::Skipped => "skipped",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskStatus::Done | TaskStatus::Escalated | TaskStatus::Failed | TaskStatus::Skipped
        )
    }
}

/// One task in a list: a prompt plus the reviewer configuration its Code Flow
/// runs with. Author steps run on the parent thread's provider (validated when the
/// child workflow starts), so only the reviewer is configured here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TaskItem {
    pub(crate) id: String,
    pub(crate) prompt: String,
    /// Reviewer provider key (e.g. `codex`); must have a hard read-only sandbox.
    pub(crate) reviewer_provider: String,
    pub(crate) reviewer_model: Option<String>,
    pub(crate) reviewer_instructions: Option<String>,
    /// Review/revise round budget for this task's Code Flow.
    pub(crate) max_rounds: u32,
    pub(crate) status: TaskStatus,
    /// The child `WorkflowRun` id driving this task (set once it starts).
    pub(crate) child_run_id: Option<String>,
    /// The final reviewer verdict for this task (`Some(true)` = approved).
    pub(crate) approved: Option<bool>,
    pub(crate) error: Option<String>,
}

impl TaskItem {
    pub(crate) fn new(
        id: impl Into<String>,
        prompt: impl Into<String>,
        reviewer_provider: impl Into<String>,
        reviewer_model: Option<String>,
        reviewer_instructions: Option<String>,
        max_rounds: u32,
    ) -> Self {
        Self {
            id: id.into(),
            prompt: prompt.into(),
            reviewer_provider: reviewer_provider.into(),
            reviewer_model,
            reviewer_instructions,
            max_rounds: max_rounds.max(1),
            status: TaskStatus::Pending,
            child_run_id: None,
            approved: None,
            error: None,
        }
    }
}

/// One execution of a task list — the object that "just sits there" while the
/// driver works through the tasks. Holds only orchestration metadata; each task's
/// real agent work lives in its child `WorkflowRun` (referenced by
/// `TaskItem::child_run_id`) and that run's background threads.
///
/// `Default` + `#[serde(default)]` give persistence forward-compat: a run written
/// by a future build that adds a field still decodes here, and a run missing its
/// `status` decodes to the SAFE terminal `Failed` (never a non-terminal state that
/// would strand the workspace lock with no driver).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TaskListRun {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) parent_thread_id: String,
    /// The provider transcript entry the run was triggered from; the frontend
    /// positions the list card after it (bottom-fallback when compacted out).
    pub(crate) anchor_item_id: String,
    pub(crate) status: RunStatus,
    /// Index of the task currently running (or next to run). Equals `tasks.len()`
    /// once every task has been consumed.
    pub(crate) current_index: usize,
    pub(crate) tasks: Vec<TaskItem>,
    pub(crate) on_escalate: EscalatePolicy,
    pub(crate) checkpoint: CheckpointMode,
    pub(crate) cwd: String,
    pub(crate) requested_by_device_id: String,
    pub(crate) requested_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) error: Option<String>,
}

impl TaskListRun {
    pub(crate) fn new(
        id: String,
        name: String,
        parent_thread_id: String,
        anchor_item_id: String,
        tasks: Vec<TaskItem>,
        on_escalate: EscalatePolicy,
        checkpoint: CheckpointMode,
        cwd: String,
        requested_by_device_id: String,
    ) -> Self {
        let now = unix_now();
        Self {
            id,
            name,
            parent_thread_id,
            anchor_item_id,
            status: RunStatus::Queued,
            current_index: 0,
            tasks,
            on_escalate,
            checkpoint,
            cwd,
            requested_by_device_id,
            requested_at: now,
            updated_at: now,
            error: None,
        }
    }

    /// Advance the run's status. Terminal is final (same guard as `WorkflowRun`): a
    /// cancel/interrupt that won a race can't be clobbered by a later between-task
    /// write. `Blocked`/`Resolving` are also sticky until an explicit recovery.
    pub(crate) fn set_status(&mut self, status: RunStatus) {
        if self.status.is_terminal()
            || matches!(self.status, RunStatus::Blocked | RunStatus::Resolving)
        {
            return;
        }
        self.status = status;
        self.updated_at = unix_now();
    }

    pub(crate) fn fail(&mut self, error: impl Into<String>) {
        if self.status.is_terminal()
            || matches!(self.status, RunStatus::Blocked | RunStatus::Resolving)
        {
            return;
        }
        self.error = Some(error.into());
        self.set_status(RunStatus::Failed);
    }

    pub(crate) fn block(&mut self, error: impl Into<String>) {
        if self.status.is_terminal() {
            return;
        }
        self.error = Some(error.into());
        self.status = RunStatus::Blocked;
        self.updated_at = unix_now();
    }

    pub(crate) fn begin_resolving_blocked(&mut self) -> bool {
        if !matches!(self.status, RunStatus::Blocked) {
            return false;
        }
        self.status = RunStatus::Resolving;
        self.updated_at = unix_now();
        true
    }

    pub(crate) fn resolve_blocked_as_failed(&mut self, error: impl Into<String>) {
        if !matches!(self.status, RunStatus::Resolving) {
            return;
        }
        self.error = Some(error.into());
        self.status = RunStatus::Failed;
        self.updated_at = unix_now();
    }

    pub(crate) fn restore_resolving_as_blocked(&mut self, error: impl Into<String>) -> bool {
        if !matches!(self.status, RunStatus::Resolving) {
            return false;
        }
        self.block(error);
        true
    }

    /// Reconcile a run whose driver is gone (restart / task death): if still
    /// non-terminal, drive it to terminal `Interrupted`, mark any in-flight task as
    /// interrupted, and mark the not-yet-run tasks `Skipped`. Returns whether it
    /// changed. A run that already settled is left untouched. TREE STATE IS NOT
    /// RESTORED — re-run resumes from the last completed (checkpointed) task.
    pub(crate) fn mark_interrupted_if_stranded(&mut self) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.error.get_or_insert_with(|| {
            "the task-list run's driver was lost; re-run to continue from the last completed task"
                .to_string()
        });
        for task in &mut self.tasks {
            match task.status {
                TaskStatus::Running => {
                    task.status = TaskStatus::Failed;
                    task.error.get_or_insert_with(|| {
                        "the task's workflow was interrupted before it finished".to_string()
                    });
                }
                TaskStatus::Pending => task.status = TaskStatus::Skipped,
                _ => {}
            }
        }
        self.status = RunStatus::Interrupted;
        self.updated_at = unix_now();
        true
    }

    /// The task the driver should run next, or `None` when the list is exhausted.
    pub(crate) fn current_task(&self) -> Option<&TaskItem> {
        self.tasks.get(self.current_index)
    }

    /// Mark the current task as started by its child workflow and record the child
    /// run id. No-op if the index is past the end.
    pub(crate) fn start_current_task(&mut self, child_run_id: impl Into<String>) {
        if let Some(task) = self.tasks.get_mut(self.current_index) {
            task.status = TaskStatus::Running;
            task.child_run_id = Some(child_run_id.into());
            self.updated_at = unix_now();
        }
    }

    /// Record the current task's terminal outcome (from its child workflow) and
    /// advance the cursor to the next task. `approved` carries the final verdict.
    /// Returns whether the list should HALT here (a non-`Done` outcome under the
    /// `Halt` escalate policy); the driver uses this to skip the remaining tasks.
    pub(crate) fn finish_current_task(
        &mut self,
        status: TaskStatus,
        approved: Option<bool>,
        error: Option<String>,
    ) -> bool {
        let halt = if let Some(task) = self.tasks.get_mut(self.current_index) {
            task.status = status;
            task.approved = approved;
            if task.error.is_none() {
                task.error = error;
            }
            // Halt on any non-Done terminal outcome unless the policy says continue.
            status != TaskStatus::Done
                && !(status == TaskStatus::Escalated
                    && self.on_escalate == EscalatePolicy::Continue)
        } else {
            false
        };
        self.current_index += 1;
        self.updated_at = unix_now();
        if halt {
            self.skip_remaining();
        }
        halt
    }

    /// Mark every not-yet-terminal task from the cursor onward as `Skipped` (used
    /// when the list halts on a failed/escalated task).
    pub(crate) fn skip_remaining(&mut self) {
        for task in self.tasks.iter_mut().skip(self.current_index) {
            if !task.status.is_terminal() {
                task.status = TaskStatus::Skipped;
            }
        }
        self.updated_at = unix_now();
    }

    /// Whether every task has reached a terminal status.
    pub(crate) fn all_tasks_terminal(&self) -> bool {
        self.tasks.iter().all(|task| task.status.is_terminal())
    }

    /// The terminal list status implied by the task outcomes: `Done` when every
    /// task is `Done`, else `Escalated` (at least one task did not get approved).
    /// The driver applies this once the list finishes without a hard failure.
    pub(crate) fn terminal_status_from_tasks(&self) -> RunStatus {
        if self
            .tasks
            .iter()
            .all(|task| task.status == TaskStatus::Done)
        {
            RunStatus::Done
        } else {
            RunStatus::Escalated
        }
    }

    pub(crate) fn done_count(&self) -> usize {
        self.tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Done)
            .count()
    }

    /// The terminal LIST status the driver applies once the run finishes: `Failed`
    /// if any task hit a hard failure (its Code Flow errored / was interrupted),
    /// else `Done` when every task was approved, else `Escalated` (a task ran out of
    /// review rounds or was skipped by a halt). Distinct from
    /// `terminal_status_from_tasks`, which only separates Done/Escalated.
    pub(crate) fn final_status_from_tasks(&self) -> RunStatus {
        if self
            .tasks
            .iter()
            .any(|task| task.status == TaskStatus::Failed)
        {
            RunStatus::Failed
        } else if self
            .tasks
            .iter()
            .all(|task| task.status == TaskStatus::Done)
        {
            RunStatus::Done
        } else {
            RunStatus::Escalated
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str) -> TaskItem {
        TaskItem::new(id, format!("do {id}"), "codex", None, None, 2)
    }

    fn sample_run(n: usize) -> TaskListRun {
        let tasks = (0..n).map(|i| task(&format!("t{i}"))).collect();
        TaskListRun::new(
            "list-1".to_string(),
            "Nightly list".to_string(),
            "parent-1".to_string(),
            "anchor-1".to_string(),
            tasks,
            EscalatePolicy::Halt,
            CheckpointMode::Commit,
            "/tmp".to_string(),
            "device-1".to_string(),
        )
    }

    #[test]
    fn terminal_status_is_never_resurrected() {
        // Mirrors the workflow/review terminal-guard: a cancel/interrupt that reached
        // terminal must survive the driver's next between-task write.
        for terminal in [
            RunStatus::Done,
            RunStatus::Escalated,
            RunStatus::Failed,
            RunStatus::Interrupted,
            RunStatus::Cancelled,
        ] {
            let mut run = sample_run(3);
            run.set_status(RunStatus::Running);
            run.set_status(terminal);
            run.set_status(RunStatus::Running);
            assert_eq!(
                run.status, terminal,
                "a terminal list run ({terminal:?}) was resurrected by a later write",
            );
        }
    }

    #[test]
    fn happy_path_all_done_advances_and_reports_done() {
        let mut run = sample_run(3);
        run.set_status(RunStatus::Running);
        for i in 0..3 {
            assert_eq!(run.current_index, i);
            let child = format!("workflow-{i}");
            run.start_current_task(&child);
            assert_eq!(run.current_task().unwrap().status, TaskStatus::Running);
            let halt = run.finish_current_task(TaskStatus::Done, Some(true), None);
            assert!(!halt, "an approved task must not halt the list");
        }
        assert!(run.all_tasks_terminal());
        assert_eq!(run.done_count(), 3);
        assert_eq!(run.terminal_status_from_tasks(), RunStatus::Done);
        assert!(run.current_task().is_none(), "cursor past the last task");
    }

    #[test]
    fn halt_policy_escalation_skips_remaining_tasks() {
        let mut run = sample_run(3);
        run.set_status(RunStatus::Running);
        run.start_current_task("workflow-0");
        assert!(!run.finish_current_task(TaskStatus::Done, Some(true), None));
        run.start_current_task("workflow-1");
        // Task 1 escalates under the default Halt policy -> list stops here.
        let halt = run.finish_current_task(TaskStatus::Escalated, Some(false), None);
        assert!(halt, "escalation under Halt must stop the list");
        assert_eq!(
            run.tasks[2].status,
            TaskStatus::Skipped,
            "later tasks skipped"
        );
        assert!(run.all_tasks_terminal());
        assert_eq!(
            run.terminal_status_from_tasks(),
            RunStatus::Escalated,
            "not every task was approved"
        );
    }

    #[test]
    fn continue_policy_runs_past_an_escalation() {
        let mut run = sample_run(3);
        run.on_escalate = EscalatePolicy::Continue;
        run.set_status(RunStatus::Running);
        run.start_current_task("workflow-0");
        let halt = run.finish_current_task(TaskStatus::Escalated, Some(false), None);
        assert!(!halt, "Continue policy must not halt on escalation");
        assert_eq!(run.current_index, 1, "cursor advanced to the next task");
        assert_eq!(
            run.tasks[1].status,
            TaskStatus::Pending,
            "next task still runnable"
        );
    }

    #[test]
    fn a_failed_task_halts_regardless_of_escalate_policy() {
        // Failure (not mere non-approval) always halts, even under Continue.
        let mut run = sample_run(3);
        run.on_escalate = EscalatePolicy::Continue;
        run.set_status(RunStatus::Running);
        run.start_current_task("workflow-0");
        let halt = run.finish_current_task(TaskStatus::Failed, None, Some("no output".to_string()));
        assert!(halt, "a hard task failure must halt even under Continue");
        assert_eq!(run.tasks[1].status, TaskStatus::Skipped);
        assert_eq!(run.tasks[0].error.as_deref(), Some("no output"));
    }

    #[test]
    fn interrupt_strands_running_and_skips_pending() {
        let mut run = sample_run(3);
        run.set_status(RunStatus::Running);
        run.start_current_task("workflow-0");
        assert!(!run.finish_current_task(TaskStatus::Done, Some(true), None));
        run.start_current_task("workflow-1"); // task 1 is Running when the driver dies

        assert!(run.mark_interrupted_if_stranded());
        assert_eq!(run.status, RunStatus::Interrupted);
        assert_eq!(
            run.tasks[0].status,
            TaskStatus::Done,
            "completed task preserved"
        );
        assert_eq!(
            run.tasks[1].status,
            TaskStatus::Failed,
            "in-flight task failed"
        );
        assert_eq!(
            run.tasks[2].status,
            TaskStatus::Skipped,
            "pending task skipped"
        );
        // Idempotent + never downgrades a settled run.
        assert!(!run.mark_interrupted_if_stranded());
        let mut done = sample_run(1);
        done.set_status(RunStatus::Done);
        assert!(!done.mark_interrupted_if_stranded());
        assert_eq!(done.status, RunStatus::Done);
    }

    #[test]
    fn blocked_run_needs_resolving_before_terminal() {
        let mut run = sample_run(2);
        run.set_status(RunStatus::Running);
        run.block("a child turn did not confirm stopping");
        assert_eq!(run.status, RunStatus::Blocked);
        assert!(!run.status.is_terminal());
        // A stray fail can't unlock a blocked run.
        run.fail("late failure");
        assert_eq!(run.status, RunStatus::Blocked);
        // Resolving is the only path to terminal.
        run.resolve_blocked_as_failed("resolved without resolving");
        assert_eq!(run.status, RunStatus::Blocked);
        assert!(run.begin_resolving_blocked());
        assert_eq!(run.status, RunStatus::Resolving);
        assert!(run.restore_resolving_as_blocked("recovery interrupted"));
        assert_eq!(run.status, RunStatus::Blocked);
        assert!(run.begin_resolving_blocked());
        run.resolve_blocked_as_failed("resolved");
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(run.error.as_deref(), Some("resolved"));
    }

    #[test]
    fn missing_status_decodes_to_failed_terminal() {
        // Persistence forward-compat: a run written without `status` (older build or
        // truncated record) must decode to a SAFE terminal state, never a
        // non-terminal one that strands the workspace lock with no driver.
        let json = r#"{"id":"list-1","name":"x","parent_thread_id":"p","cwd":"/tmp","tasks":[]}"#;
        let run: TaskListRun = serde_json::from_str(json).expect("decode run missing status");
        assert_eq!(run.status, RunStatus::Failed);
        assert!(run.status.is_terminal());
    }

    #[test]
    fn task_status_as_str_matches_serde_wire_format() {
        for status in [
            TaskStatus::Pending,
            TaskStatus::Running,
            TaskStatus::Done,
            TaskStatus::Escalated,
            TaskStatus::Failed,
            TaskStatus::Skipped,
        ] {
            let serialized = serde_json::to_value(status).expect("serialize");
            assert_eq!(
                serde_json::Value::String(status.as_str().to_string()),
                serialized,
                "as_str() disagrees with the serde wire format for {status:?}",
            );
        }
    }
}
