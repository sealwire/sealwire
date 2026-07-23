//! Serial task-list runner (phase 2, brick 2).
//!
//! Drives a `TaskListRun` through its tasks ONE AT A TIME: for each task, start a
//! child Code Flow `WorkflowRun` on the list's parent thread (reusing the phase-1
//! runner via `start_code_flow_internal`), wait for that child to reach a terminal
//! status, map the outcome to a `TaskStatus`, then advance — or halt (skipping the
//! rest) on a non-`Done` outcome under the `Halt` escalate policy, or on any hard
//! failure. Because at most one child workflow is non-terminal at a time, the
//! phase-1 `has_active_workflow()` guard is naturally satisfied: the child IS the
//! one workflow.
//!
//! Git checkpointing after each `Done` task (`CheckpointMode`) and persistence /
//! restart reconcile land in later bricks; this brick keeps the run in the
//! in-memory `task_list_jobs` map and reconciles a lost driver to `Interrupted`
//! via `TaskListLifeguard`.

use crate::protocol::{truncate_utf8_bytes_with_ellipsis, WORKFLOW_ANCHOR_STORED_BYTES};
use crate::state::{CheckpointMode, EscalatePolicy, RunStatus, TaskItem, TaskListRun, TaskStatus};

use super::review::random_suffix;
use super::*;

/// Crash-safety net: if the driver task exits while the list is still non-terminal
/// (a panic, or the process losing the task), reconcile the run to `Interrupted` so
/// it never persists `Running` with no driver. The current child workflow, if any,
/// is reconciled by its own `WorkflowRunLifeguard`.
struct TaskListLifeguard {
    app: AppState,
    run_id: String,
    disarmed: bool,
}

impl TaskListLifeguard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for TaskListLifeguard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let app = self.app.clone();
        let run_id = self.run_id.clone();
        tokio::spawn(async move {
            app.interrupt_task_list_if_stranded(&run_id).await;
        });
    }
}

impl AppState {
    /// Validate, record a `TaskListRun`, and spawn its serial driver. Returns the run
    /// id immediately; progress is observable via the snapshot stream. One list at a
    /// time, and mutually exclusive with an ad-hoc workflow/review on the workspace.
    pub async fn start_task_list(
        &self,
        device_id: Option<String>,
        name: String,
        tasks: Vec<TaskItem>,
        parent_thread_id: Option<String>,
        on_escalate: EscalatePolicy,
        checkpoint: CheckpointMode,
        mut anchor_item_id: String,
    ) -> Result<String, String> {
        truncate_utf8_bytes_with_ellipsis(&mut anchor_item_id, WORKFLOW_ANCHOR_STORED_BYTES);
        let device_id = require_device_id(device_id)?;
        self.expire_stale_controller_if_needed().await;
        if tasks.is_empty() {
            return Err("a task list needs at least one task".to_string());
        }
        // Each task's reviewer provider must be available before we record anything.
        for task in &tasks {
            self.resolve_provider(Some(&task.reviewer_provider))?;
        }

        // Hold the session slot so the guard checks + record are atomic against a
        // concurrent start.
        let _slot = self.acquire_session_slot()?;
        if self.relay.read().await.has_active_task_list() {
            return Err(
                "a task list is already running; wait for it to finish before starting another"
                    .to_string(),
            );
        }
        // Authorize + resolve the parent thread ONCE (auth before any provider probe;
        // unknown thread rejected). This also refuses a concurrent workflow/review.
        let (parent_thread_id, _author_provider, cwd) = self
            .authorize_and_resolve_workflow_parent(&device_id, parent_thread_id)
            .await?;

        let run_id = format!("tasklist-{}-{}", unix_now(), random_suffix());
        let run = TaskListRun::new(
            run_id.clone(),
            name,
            parent_thread_id.clone(),
            anchor_item_id,
            tasks,
            on_escalate,
            checkpoint,
            cwd,
            device_id,
        );
        {
            let mut relay = self.relay.write().await;
            relay.insert_task_list_run(run);
            relay.push_log(
                "info",
                format!("Task list {run_id} requested for thread {parent_thread_id}."),
            );
            relay.notify();
        }

        let app = self.clone();
        let task_run_id = run_id.clone();
        tokio::spawn(async move {
            let mut lifeguard = TaskListLifeguard {
                app: app.clone(),
                run_id: task_run_id.clone(),
                disarmed: false,
            };
            app.run_task_list_job(task_run_id).await;
            lifeguard.disarm();
        });

        Ok(run_id)
    }

    /// The serial driver. Runs each task's Code Flow to completion, advancing or
    /// halting per the outcome, then records the terminal list status.
    async fn run_task_list_job(&self, run_id: String) {
        let Some((parent_thread_id, device_id)) = self.task_list_run_context(&run_id).await else {
            return;
        };
        self.set_task_list_status(&run_id, RunStatus::Running).await;

        loop {
            let Some(task) = self.next_task_list_task(&run_id).await else {
                break; // exhausted, halted, or the run settled/vanished
            };

            let child = match self
                .start_code_flow_internal(
                    &device_id,
                    &task.prompt,
                    &task.reviewer_provider,
                    task.reviewer_model.clone(),
                    task.reviewer_instructions.clone(),
                    task.max_rounds,
                    Some(parent_thread_id.clone()),
                    String::new(),
                )
                .await
            {
                Ok(child_id) => child_id,
                Err(error) => {
                    // Couldn't even start this task's Code Flow — a hard failure.
                    if self
                        .finish_task_list_task(&run_id, TaskStatus::Failed, None, Some(error))
                        .await
                    {
                        break;
                    }
                    continue;
                }
            };
            self.mark_task_list_task_started(&run_id, &child).await;

            let (child_status, approved) = self.wait_for_child_workflow(&child).await;
            let mapped = task_status_from_child(child_status);
            let error = matches!(mapped, TaskStatus::Failed)
                .then(|| format!("the task's Code Flow ended `{}`", child_status.as_str()));
            if self
                .finish_task_list_task(&run_id, mapped, approved, error)
                .await
            {
                break;
            }
        }

        self.finalize_task_list(&run_id).await;
    }

    /// The list's constant parent thread + requesting device, read once.
    async fn task_list_run_context(&self, run_id: &str) -> Option<(String, String)> {
        let relay = self.relay.read().await;
        relay.task_list_run(run_id).map(|run| {
            (
                run.parent_thread_id.clone(),
                run.requested_by_device_id.clone(),
            )
        })
    }

    /// The next task to run, or `None` when the cursor is exhausted or the run is no
    /// longer drivable (terminal / blocked / cancelled / gone).
    async fn next_task_list_task(&self, run_id: &str) -> Option<TaskItem> {
        let relay = self.relay.read().await;
        let run = relay.task_list_run(run_id)?;
        if run.status.is_terminal()
            || matches!(run.status, RunStatus::Blocked | RunStatus::Resolving)
        {
            return None;
        }
        run.current_task().cloned()
    }

    async fn mark_task_list_task_started(&self, run_id: &str, child_id: &str) {
        let child_id = child_id.to_string();
        let mut relay = self.relay.write().await;
        relay.update_task_list_run(run_id, |run| run.start_current_task(child_id));
        relay.notify();
    }

    /// Record the current task's outcome and advance the cursor. Returns whether the
    /// list should HALT here (per `TaskListRun::finish_current_task`).
    async fn finish_task_list_task(
        &self,
        run_id: &str,
        status: TaskStatus,
        approved: Option<bool>,
        error: Option<String>,
    ) -> bool {
        let mut halt = false;
        {
            let mut relay = self.relay.write().await;
            relay.update_task_list_run(run_id, |run| {
                halt = run.finish_current_task(status, approved, error);
            });
            relay.notify();
        }
        halt
    }

    async fn set_task_list_status(&self, run_id: &str, status: RunStatus) {
        let mut relay = self.relay.write().await;
        relay.update_task_list_run(run_id, |run| run.set_status(status));
        relay.notify();
    }

    async fn finalize_task_list(&self, run_id: &str) {
        let mut relay = self.relay.write().await;
        let Some(final_status) = relay
            .task_list_run(run_id)
            .map(|run| run.final_status_from_tasks())
        else {
            return;
        };
        relay.update_task_list_run(run_id, |run| run.set_status(final_status));
        relay.push_log(
            "info",
            format!("Task list {run_id} finished: {}.", final_status.as_str()),
        );
        relay.notify();
    }

    /// Wait until child workflow `child_id` settles. Returns its terminal status +
    /// the last verdict's `approved`. Treats `Blocked` as a stop (the child owns
    /// stuck threads and can't make progress); a vanished child reads as `Failed`.
    async fn wait_for_child_workflow(&self, child_id: &str) -> (RunStatus, Option<bool>) {
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                match relay.workflow_run(child_id) {
                    Some(run)
                        if run.status.is_terminal() || matches!(run.status, RunStatus::Blocked) =>
                    {
                        return (run.status, run.last_verdict.as_ref().map(|v| v.approved));
                    }
                    Some(_) => {}
                    None => return (RunStatus::Failed, None),
                }
            }
            if rx.changed().await.is_err() {
                let relay = self.relay.read().await;
                return match relay.workflow_run(child_id) {
                    Some(run) => (run.status, run.last_verdict.as_ref().map(|v| v.approved)),
                    None => (RunStatus::Failed, None),
                };
            }
        }
    }

    async fn interrupt_task_list_if_stranded(&self, run_id: &str) {
        let mut interrupted = false;
        {
            let mut relay = self.relay.write().await;
            relay.update_task_list_run(run_id, |run| {
                run.error
                    .get_or_insert_with(|| "the task-list driver exited unexpectedly".to_string());
                interrupted = run.mark_interrupted_if_stranded();
            });
            if interrupted {
                relay.push_log(
                    "warn",
                    format!("Task list {run_id} was interrupted because its driver exited."),
                );
            }
            relay.notify();
        }
    }
}

/// Map a child Code Flow's terminal status to the task's status. `Done` = the
/// reviewer approved; `Escalated` = ran out of rounds; anything else (Failed /
/// Interrupted / Cancelled / Blocked) is a hard task failure.
fn task_status_from_child(child: RunStatus) -> TaskStatus {
    match child {
        RunStatus::Done => TaskStatus::Done,
        RunStatus::Escalated => TaskStatus::Escalated,
        _ => TaskStatus::Failed,
    }
}
