//! Serial workflow runner (phase 1).
//!
//! Generalizes the review orchestrator into a configurable pipeline: an optional
//! `Execute` step runs once on the parent (author) thread, then a `Review` step
//! (on a spawned background reviewer thread) and a `Revise` step (back on the
//! parent) loop up to `max_rounds` until the reviewer's structured verdict is
//! `approved` (Done) or the budget runs out (Escalated). Execute/Revise run on
//! the parent; Review runs on a dedicated background thread — exactly the
//! parent/reviewer split the review orchestrator uses.
//!
//! Phase 1 is intentionally lean: serial steps, the `ReviewerApproved` stop, no
//! cancel, no per-step worktree isolation. The verdict is derived from the
//! reviewer's `VERDICT:` line (reusing the review parser) — real-provider
//! structured-output extraction is a later chunk. Crash-safety (a lifeguard) and
//! the working-tree lock are separate chunks; every error path here still drives
//! the run to a terminal state on its own.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::time::Instant;

use crate::state::{
    parse_verdict, re_review_prompt, reviewer_prompt, RunStatus, StepRole, Workflow, WorkflowRun,
    WorkflowStep, WorkflowVerdict,
};

use super::*;

/// Hard cap on the review/revise loop so a single run can't loop unbounded.
const MAX_WORKFLOW_ROUNDS: u32 = 20;

/// Backstop stall timeout for a single step's turn. The wait returns as soon as
/// the turn completes; this only trips on a step that makes no progress at all
/// for the whole window (a wedged provider), never on a normally-running step.
const WORKFLOW_STEP_STALL_SECS: u64 = 600;

/// Process-unique suffix source for run ids (avoids pulling in the review
/// module's RNG helper; uniqueness within a process is all a run id needs).
static WORKFLOW_RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Outcome of waiting for a step's in-flight turn to settle.
enum StepOutcome {
    Completed,
    /// The turn parked on an approval / question — a non-interactive workflow
    /// can't answer, so the step is treated as failed.
    NeedsHuman,
    TimedOut,
}

struct WorkflowRunFields {
    parent_thread_id: String,
    cwd: String,
}

impl AppState {
    /// Validate, record a `WorkflowRun`, and spawn the orchestrator. Returns the
    /// run id immediately; progress is observable via the snapshot stream.
    pub async fn start_workflow(
        &self,
        device_id: Option<String>,
        workflow: Workflow,
        anchor_item_id: String,
    ) -> Result<String, String> {
        let device_id = require_device_id(device_id)?;
        self.expire_stale_controller_if_needed().await;

        // Every step's provider must be available before we record the run.
        for step in &workflow.steps {
            self.resolve_provider(Some(&step.agent))?;
        }

        // Briefly hold the session slot to validate + record atomically; the run
        // itself executes in the background.
        let _slot = self.acquire_session_slot()?;
        let (parent_thread_id, cwd) = {
            let relay = self.relay.read().await;
            relay.ensure_device_can_send_message(&device_id)?;
            let parent = relay
                .active_thread_id
                .clone()
                .ok_or_else(|| "there is no active thread to run a workflow on".to_string())?;
            if relay.active_turn_id.is_some() {
                return Err("cannot start a workflow while a turn is in progress".to_string());
            }
            if !relay.pending_approvals.is_empty() {
                return Err("cannot start a workflow while approvals are pending".to_string());
            }
            if relay.current_status != "idle" {
                return Err(format!(
                    "cannot start a workflow while the agent is `{}`",
                    relay.current_status
                ));
            }
            // A backgrounded thread sharing this cwd could mutate files mid-run; a
            // proper working-tree lock lands in a later chunk, but refuse the
            // obvious race now.
            if relay.has_working_thread_in_cwd(&relay.current_cwd) {
                return Err(
                    "another thread is running in this workspace; wait for it to \
finish before starting a workflow"
                        .to_string(),
                );
            }
            (parent, relay.current_cwd.clone())
        };

        let seq = WORKFLOW_RUN_SEQ.fetch_add(1, Ordering::Relaxed);
        let run_id = format!("workflow-{}-{}", unix_now(), seq);
        let run = WorkflowRun::new(
            run_id.clone(),
            workflow.id.clone(),
            parent_thread_id.clone(),
            anchor_item_id,
            cwd,
            device_id,
        );
        {
            let mut relay = self.relay.write().await;
            relay.insert_workflow_run(run);
            relay.push_log(
                "info",
                format!(
                    "Workflow {run_id} ({}) requested for thread {parent_thread_id}.",
                    workflow.name
                ),
            );
            relay.notify();
        }

        let app = self.clone();
        let task_run_id = run_id.clone();
        tokio::spawn(async move {
            app.run_workflow_job(task_run_id, workflow).await;
        });

        Ok(run_id)
    }

    async fn run_workflow_job(&self, run_id: String, workflow: Workflow) {
        let Some(WorkflowRunFields {
            parent_thread_id,
            cwd,
        }) = self.workflow_run_fields(&run_id).await
        else {
            return;
        };
        self.set_run_status(&run_id, RunStatus::Running).await;
        self.push_runtime_log(
            "info",
            format!(
                "Workflow {run_id} ({}) started on thread {parent_thread_id}.",
                workflow.name
            ),
        )
        .await;

        let execute = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Execute)
            .cloned();
        let review = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Review)
            .cloned();
        let revise = workflow
            .steps
            .iter()
            .find(|s| s.role == StepRole::Revise)
            .cloned();
        let max_rounds = workflow
            .loop_
            .as_ref()
            .map(|l| l.max_rounds)
            .unwrap_or(1)
            .clamp(1, MAX_WORKFLOW_ROUNDS);

        // 1. Execute once on the parent (author) thread.
        if let Some(step) = &execute {
            self.set_run_step(&run_id, &step.id).await;
            let prompt = step_prompt(step, "Implement the requested change for review.");
            if self.run_turn(&parent_thread_id, &prompt).await.is_none() {
                self.fail_run(&run_id, "the execute step produced no output")
                    .await;
                return;
            }
        }

        // No review step -> single-step workflow, done after execute.
        let Some(review) = review else {
            self.finish_run(&run_id, RunStatus::Done).await;
            return;
        };

        // 2. Spawn the reviewer thread once; reused across rounds.
        let reviewer_thread_id = match self.start_workflow_step_thread(&cwd, &review.agent).await {
            Ok(id) => id,
            Err(error) => {
                self.fail_run(
                    &run_id,
                    format!("failed to start the reviewer thread: {error}"),
                )
                .await;
                return;
            }
        };
        {
            let reviewer_thread_id = reviewer_thread_id.clone();
            let step_id = review.id.clone();
            self.update_run(&run_id, move |r| {
                r.step_threads.insert(step_id, reviewer_thread_id);
            })
            .await;
        }

        // 3. Review / revise loop.
        let mut round: u32 = 0;
        loop {
            round += 1;
            let diff = match collect_workspace_diff(&cwd).await {
                Ok(diff) => diff,
                Err(error) => {
                    self.fail_run(
                        &run_id,
                        format!("failed to collect the workspace diff: {error}"),
                    )
                    .await;
                    return;
                }
            };
            let recap = self
                .latest_assistant_entry(&parent_thread_id)
                .await
                .map(|(_, text)| text)
                .unwrap_or_default();
            let instructions = non_empty(Some(review.prompt.clone()));
            let prompt = if round == 1 {
                reviewer_prompt(&recap, &diff, instructions.as_deref())
            } else {
                re_review_prompt(&recap, &diff, instructions.as_deref())
            };

            self.set_run_step(&run_id, &review.id).await;
            let review_text = match self.run_turn(&reviewer_thread_id, &prompt).await {
                Some(text) => text,
                None => {
                    self.fail_run(&run_id, "the reviewer produced no review for this round")
                        .await;
                    return;
                }
            };
            let approved = parse_verdict(&review_text).is_approved();
            let verdict = if approved {
                WorkflowVerdict::approved()
            } else {
                WorkflowVerdict::needs_changes(Vec::new())
            };
            {
                let round_now = round;
                let verdict = verdict.clone();
                self.update_run(&run_id, move |r| {
                    r.round = round_now;
                    r.last_verdict = Some(verdict);
                })
                .await;
            }
            self.push_runtime_log(
                "info",
                format!("Workflow {run_id}: round {round}/{max_rounds} — approved={approved}."),
            )
            .await;

            if approved {
                self.finish_run(&run_id, RunStatus::Done).await;
                return;
            }
            if round >= max_rounds {
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            }

            // 4. Revise on the parent; require a FRESH reply, else short-circuit so we
            // don't burn rounds re-reviewing an unchanged artifact.
            let Some(revise) = &revise else {
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            };
            self.set_run_step(&run_id, &revise.id).await;
            let revise_prompt = step_prompt(
                revise,
                &format!(
                    "A reviewer did not approve your changes. Address the findings below; the \
reviewer will look again afterward.\n\n{review_text}"
                ),
            );
            if self
                .run_turn(&parent_thread_id, &revise_prompt)
                .await
                .is_none()
            {
                self.push_runtime_log(
                    "info",
                    format!("Workflow {run_id}: revise produced no change; escalating."),
                )
                .await;
                self.finish_run(&run_id, RunStatus::Escalated).await;
                return;
            }
        }
    }

    /// Send `prompt` to `thread_id`, wait for the turn to settle, and return the
    /// fresh assistant reply text (i.e. an entry whose id differs from the
    /// pre-turn baseline). `None` on any failure or if no new reply landed.
    async fn run_turn(&self, thread_id: &str, prompt: &str) -> Option<String> {
        let baseline = self
            .latest_assistant_entry(thread_id)
            .await
            .map(|(id, _)| id);
        match self
            .send_message_to_thread(thread_id, prompt, None, None)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => return None,
        }
        match self.wait_for_step_idle(thread_id).await {
            StepOutcome::Completed => {}
            StepOutcome::NeedsHuman | StepOutcome::TimedOut => return None,
        }
        match self.latest_assistant_entry(thread_id).await {
            Some((id, text)) if baseline.as_deref() != Some(id.as_str()) => Some(text),
            _ => None,
        }
    }

    /// Wait until `thread_id`'s in-flight turn settles. Mirrors the review wait's
    /// idle signal (`runtime.is_working()`) and stall-deadline reset on progress,
    /// but is decoupled from review-job state (no cancel flag).
    async fn wait_for_step_idle(&self, thread_id: &str) -> StepOutcome {
        let timeout = Duration::from_secs(WORKFLOW_STEP_STALL_SECS);
        let mut deadline = Instant::now() + timeout;
        let mut last_revision = {
            let relay = self.relay.read().await;
            relay
                .runtime_for_thread(thread_id)
                .map(|runtime| runtime.transcript_revision)
                .unwrap_or(0)
        };
        let mut rx = self.subscribe();
        loop {
            {
                let relay = self.relay.read().await;
                let parked = relay
                    .pending_approvals
                    .values()
                    .any(|approval| approval.thread_id == thread_id)
                    || relay
                        .pending_ask_user_questions
                        .values()
                        .any(|question| question.thread_id == thread_id);
                if parked {
                    return StepOutcome::NeedsHuman;
                }
                let (working, revision) = match relay.runtime_for_thread(thread_id) {
                    Some(runtime) => (runtime.is_working(), runtime.transcript_revision),
                    None => (false, last_revision),
                };
                if !working {
                    return StepOutcome::Completed;
                }
                if revision != last_revision {
                    last_revision = revision;
                    deadline = Instant::now() + timeout;
                }
            }
            tokio::select! {
                changed = rx.changed() => {
                    if changed.is_err() {
                        return StepOutcome::Completed;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return StepOutcome::TimedOut;
                }
            }
        }
    }

    /// Spawn a background thread on `provider` for a step (the reviewer). Does not
    /// become the active thread. Phase 1 uses session defaults; read-only
    /// enforcement for a real reviewer lands with provider wiring.
    async fn start_workflow_step_thread(
        &self,
        cwd: &str,
        provider: &str,
    ) -> Result<String, String> {
        let (provider_name, bridge) = {
            let (name, bridge) = self.resolve_provider(Some(provider))?;
            (name.to_string(), bridge.clone())
        };
        let defaults = self.defaults().await;
        let model = defaults.model.clone();
        let approval_policy = defaults.approval_policy.clone();
        let sandbox = defaults.sandbox.clone();
        let effort = defaults.reasoning_effort.clone();

        let start = bridge
            .start_thread(cwd, &model, &approval_policy, &sandbox, None)
            .await?;
        let mut thread = start.thread;
        thread.provider = provider_name.clone();
        thread.source = provider_name.clone();
        let thread_id = thread.id.clone();
        {
            let mut relay = self.relay.write().await;
            relay.register_background_thread(
                thread,
                cwd,
                &model,
                &approval_policy,
                &sandbox,
                &effort,
            );
            relay.push_log(
                "info",
                format!("Workflow: started a {provider_name} background step thread in {cwd}."),
            );
            relay.notify();
        }
        Ok(thread_id)
    }

    async fn workflow_run_fields(&self, run_id: &str) -> Option<WorkflowRunFields> {
        let relay = self.relay.read().await;
        relay.workflow_run(run_id).map(|run| WorkflowRunFields {
            parent_thread_id: run.parent_thread_id.clone(),
            cwd: run.cwd.clone(),
        })
    }

    async fn update_run<F: FnOnce(&mut WorkflowRun)>(&self, run_id: &str, update: F) {
        let mut relay = self.relay.write().await;
        relay.update_workflow_run(run_id, update);
        relay.notify();
    }

    async fn set_run_status(&self, run_id: &str, status: RunStatus) {
        self.update_run(run_id, move |run| run.set_status(status))
            .await;
    }

    async fn set_run_step(&self, run_id: &str, step_id: &str) {
        let step_id = step_id.to_string();
        self.update_run(run_id, move |run| run.set_current_step(step_id))
            .await;
    }

    async fn finish_run(&self, run_id: &str, status: RunStatus) {
        self.update_run(run_id, move |run| run.set_status(status))
            .await;
        self.push_runtime_log(
            "info",
            format!("Workflow {run_id} finished: {}.", status.as_str()),
        )
        .await;
    }

    async fn fail_run(&self, run_id: &str, error: impl Into<String>) {
        let error = error.into();
        let logged = error.clone();
        self.update_run(run_id, move |run| run.fail(error)).await;
        self.push_runtime_log("warn", format!("Workflow {run_id} failed: {logged}"))
            .await;
    }
}

/// The step's own prompt, or a role default when it carries none.
fn step_prompt(step: &WorkflowStep, default: &str) -> String {
    let trimmed = step.prompt.trim();
    if trimmed.is_empty() {
        default.to_string()
    } else {
        trimmed.to_string()
    }
}
